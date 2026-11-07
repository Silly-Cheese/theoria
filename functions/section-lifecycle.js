import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();
const callableOptions = { region: "us-central1", maxInstances: 6 };

function fail(code, message) { throw new HttpsError(code, message); }
function assert(condition, code, message) { if (!condition) fail(code, message); }
function validId(value) { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }

// Do not risk losing student results. The no-history condition is intentionally
// stricter than a visible student count: a single nested subcollection doc blocks
// permanent deletion. Section archives preserve all educational records.
async function inspectSection(sectionId) {
  const sectionRef = db.doc("sections/" + sectionId);
  const [collections, assessments] = await Promise.all([
    sectionRef.listCollections(),
    db.collection("assessments").where("sectionId", "==", sectionId).limit(1).get()
  ]);
  const checks = await Promise.all(collections.map(async col => {
    const docs = await col.limit(1).get();
    return { name: col.id, populated: !docs.empty };
  }));
  const present = checks.filter(row => row.populated).map(row => row.name);
  if (!assessments.empty) present.push("linked assessments");
  return { sectionRef, present, empty: present.length === 0 };
}

export const sectionLifecycle = onCall(callableOptions, async request => {
  const uid = request.auth?.uid, data = request.data || {};
  assert(!!uid, "unauthenticated", "Sign in to manage this section.");
  assert(validId(data.sectionId), "invalid-argument", "Choose a valid section.");
  const sectionRef = db.doc("sections/" + data.sectionId);
  const section = await sectionRef.get();
  assert(section.exists, "not-found", "The section was not found.");
  assert(section.data().ownerId === uid, "permission-denied",
    "Only the section owner can archive or permanently delete this section.");
  const sectionData = section.data();
  const linked = !!sectionData.institutionId;
  const inspection = await inspectSection(data.sectionId);
  const canDelete = !linked && inspection.empty;
  if (data.action === "inspect") return {
    sectionId: data.sectionId, sectionName: sectionData.sectionName || sectionData.courseTitle || "",
    canDelete, linked, hasAcademicOrRelatedData: !inspection.empty,
    dataCategories: inspection.present,
    recommendation: canDelete ? "delete" : "archive"
  };
  assert(["archive", "delete"].includes(data.action), "invalid-argument", "Invalid section action.");
  if (data.action === "archive") {
    assert(!linked, "failed-precondition",
      "This section is linked to a school. Coordinate closure through its registrar.");
    await db.runTransaction(async tx => {
      const fresh = await tx.get(sectionRef);
      assert(fresh.exists && fresh.data().ownerId === uid, "permission-denied",
        "Section owner permissions have changed.");
      const previous = fresh.data();
      assert(previous.status !== "Archived", "failed-precondition", "Section is already archived.");
      tx.update(sectionRef, {
        status: "Archived", joinOpen: false, archivedBy: uid,
        archivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      if (previous.joinCode && /^THR-[A-Z0-9]+$/.test(previous.joinCode)) {
        const joinRef = db.doc("joinCodes/" + previous.joinCode);
        const join = await tx.get(joinRef);
        if (join.exists && join.data().sectionId === data.sectionId) {
          tx.update(joinRef, { active: false, updatedAt: FieldValue.serverTimestamp() });
        }
      }
      tx.create(db.collection("systemAcademicAudit").doc(), {
        actorUid: uid, action: "section_archived",
        sectionId: data.sectionId, createdAt: FieldValue.serverTimestamp()
      });
    });
    return { status: "archived", message: "Section archived; student and academic records preserved." };
  }
  assert(data.confirmation === "DELETE", "invalid-argument",
    "Type DELETE to confirm permanent deletion.");
  assert(canDelete, "failed-precondition",
    linked ? "School-linked sections cannot be permanently deleted here." :
    "This section contains related data. Archive it instead to preserve academic records.");
  // Mark the empty section as closed before removing it, to prevent new joins.
  await db.runTransaction(async tx => {
    const fresh = await tx.get(sectionRef);
    assert(fresh.exists && fresh.data().ownerId === uid, "permission-denied",
      "Section ownership changed.");
    assert(!fresh.data().institutionId, "failed-precondition", "School-linked section.");
    tx.update(sectionRef, {
      joinOpen: false, status: "PendingDeletion", lifecycleStatus: "deleting",
      updatedAt: FieldValue.serverTimestamp()
    });
    const code = fresh.data().joinCode;
    if (code && /^THR-[A-Z0-9]+$/.test(code)) {
      const joinRef = db.doc("joinCodes/" + code);
      const join = await tx.get(joinRef);
      if (join.exists && join.data().sectionId === data.sectionId)
        tx.update(joinRef, { active: false, updatedAt: FieldValue.serverTimestamp() });
    }
  });
  // Fail-closed if new records appeared during the short transition.
  const finalCheck = await inspectSection(data.sectionId);
  assert(finalCheck.empty, "failed-precondition",
    "Related records appeared during deletion. The section was closed; archive it instead.");
  // The section has no children and no assessments. No student data is removed.
  await db.collection("systemAcademicAudit").add({
    actorUid: uid, action: "empty_section_deleted",
    sectionId: data.sectionId,
    courseId: sectionData.courseId || "",
    sectionName: sectionData.sectionName || sectionData.courseTitle || "",
    createdAt: FieldValue.serverTimestamp()
  });
  if (sectionData.joinCode && /^THR-[A-Z0-9]+$/.test(sectionData.joinCode)) {
    const joinRef = db.doc("joinCodes/" + sectionData.joinCode);
    const currentJoin = await joinRef.get();
    if (currentJoin.exists && currentJoin.data().sectionId === data.sectionId)
      await joinRef.delete();
  }
  await sectionRef.delete();
  return { status: "deleted", message: "The empty section was permanently deleted." };
});
