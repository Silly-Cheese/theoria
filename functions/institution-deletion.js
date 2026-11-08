import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();
const callOptions = { region: "us-central1", maxInstances: 6 };
const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = (code, message) => { throw new HttpsError(code, message); };
const must = (condition, message, code = "failed-precondition") => {
  if (!condition) fail(code, message);
};
const collectionFor = { offering: "offerings", term: "terms",
  department: "departments", invitation: "invitations" };
const privilege = { offering: ["owner","principal","assistant_principal","registrar","district_admin"],
  term: ["owner","principal","district_admin"],
  department: ["owner","principal","district_admin"],
  invitation: ["owner"] };

async function institutionRole(institutionId, uid) {
  const root = db.doc("institutions/" + institutionId);
  const [school, staff] = await Promise.all([root.get(), root.collection("staff").doc(uid).get()]);
  must(school.exists, "Institution was not found.", "not-found");
  const role = school.data().ownerUid === uid ? "owner" : staff.data()?.role || "";
  return { root, institution: school.data(), role };
}
async function dependencyReport(root, kind, targetId) {
  if (kind === "institution") {
    const collections = await root.listCollections();
    const populated = await Promise.all(collections.map(async c => ({
      name:c.id, hasDocuments: !(await c.limit(1).get()).empty
    })));
    const subcollectionNames = populated.filter(c=>c.hasDocuments).map(c=>c.name);
    const childSchools = await db.collection("institutions")
      .where("parentDistrictId","==",root.id).limit(1).get();
    if (!childSchools.empty) subcollectionNames.push("linked schools");
    return subcollectionNames;
  }
  if (kind === "offering") {
    const linked = await root.collection("offerings").doc(targetId).get();
    const queries = ["registrations","requests","placements"].map(n =>
      root.collection(n).where("offeringId","==",targetId).limit(1).get());
    const results = await Promise.all(queries);
    const blockers = ["registrations","requests","placements"]
      .filter((n,i)=>!results[i].empty);
    if (linked.exists && linked.data().sectionId) blockers.push("linked teaching section");
    return blockers;
  }
  if (kind === "term") {
    const term = await root.collection("terms").doc(targetId).get();
    if (!term.exists) return [];
    const offerings = await root.collection("offerings")
      .where("term","==",term.data().title).limit(1).get();
    return offerings.empty?[]:["course offerings in this term"];
  }
  if (kind === "department") {
    const programs = await root.collection("academicPrograms").where("departmentId","==",targetId).limit(1).get();
    return programs.empty ? [] : ["academic programs using this department"];
  }
  return [];
}
async function inspect(root, kind, targetId) {
  const blockers = await dependencyReport(root, kind, targetId);
  return { kind, targetId, canDelete: blockers.length === 0, blockers,
    guidance: blockers.length ? "Archive or withdraw dependent records first. Nothing was deleted." :
      "No blocking dependent records were found." };
}

export const institutionDelete = onCall(callOptions, async request => {
  const uid = request.auth?.uid, input = request.data || {};
  must(!!uid, "Sign in to continue.", "unauthenticated");
  must(valid(input.institutionId), "Choose a valid school or district.", "invalid-argument");
  const kind = input.kind;
  must(kind === "institution" || Object.hasOwn(collectionFor,kind),
    "Unknown record type.", "invalid-argument");
  const { root, role, institution } = await institutionRole(input.institutionId, uid);
  must(role === "owner" || privilege[kind]?.includes(role),
    "You do not have permission to delete this record.", "permission-denied");
  const targetId = kind === "institution" ? input.institutionId : input.targetId;
  must(typeof targetId === "string" && targetId.length >= 1 && targetId.length <= 220 &&
    !targetId.includes("/") && !targetId.includes(".."),
    "Invalid record identifier.", "invalid-argument");
  if (kind === "institution") {
    must(role === "owner", "Only the institution owner can permanently delete it.", "permission-denied");
    must(institution.status === "active" || institution.status === "archived",
      "Institution cannot be deleted in its current state.");
  }
  const ref = kind === "institution" ? root : root.collection(collectionFor[kind]).doc(targetId);
  const target = await ref.get();
  must(target.exists, "This record was already deleted.", "not-found");
  const result = await inspect(root, kind, targetId);
  if (input.action === "inspect") return result;
  must(input.action === "delete", "Invalid deletion action.", "invalid-argument");
  must(input.confirmation === "DELETE", "Type DELETE to confirm this operation.", "invalid-argument");
  must(result.canDelete, result.blockers.join(", ") +
    " prevent permanent deletion. No academic records were removed.");
  // Recheck dependent rows inside a transaction for individual records.
  if (kind !== "institution") {
    return db.runTransaction(async tx => {
      const stillExists = await tx.get(ref);
      must(stillExists.exists, "Record was already removed.", "not-found");
      if (kind === "offering") {
        const [reg, req, placed] = await Promise.all(["registrations","requests","placements"]
          .map(name => tx.get(root.collection(name).where("offeringId","==",targetId).limit(1))));
        must(reg.empty && req.empty && placed.empty && !stillExists.data().sectionId,
          "Course offering now has linked student or section records.");
      }
      if (kind === "term") {
        const used = await tx.get(root.collection("offerings")
          .where("term","==",stillExists.data().title).limit(1));
        must(used.empty, "Academic term is used by a course offering.");
      }
      if (kind === "department") {
        const used = await tx.get(root.collection("academicPrograms")
          .where("departmentId","==",targetId).limit(1));
        must(used.empty, "Department is used by an academic program.");
      }
      tx.delete(ref);
      tx.create(root.collection("auditEvents").doc(), {
        createdBy: uid, createdAt: FieldValue.serverTimestamp(),
        action: kind + "_deleted", targetId
      });
      return { status: "deleted", kind, targetId };
    });
  }
  // If there is any institutional subcollection with data, preserve the
  // institution and use archive instead. Never leave orphan student records.
  must((await dependencyReport(root, "institution", targetId)).length === 0,
    "The institution now has related records. Archive it instead.");
  return db.runTransaction(async tx => {
    const fresh = await tx.get(root);
    must(fresh.exists && fresh.data().ownerUid === uid,
      "Institution ownership changed.", "permission-denied");
    // Avoid deleting districts with active schools. Transaction query reads
    // make a concurrent district affiliation re-evaluate this operation.
    const children = await tx.get(db.collection("institutions")
      .where("parentDistrictId","==",root.id).limit(1));
    must(children.empty,"District still contains schools.");
    tx.delete(root);
    tx.create(db.collection("systemAcademicAudit").doc(),{
      action: "empty_institution_deleted",
      institutionId: input.institutionId, institutionName: fresh.data().name,
      actorUid: uid, createdAt: FieldValue.serverTimestamp()
    });
    return {status:"deleted",kind:"institution",targetId};
  });
});
