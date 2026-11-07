import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { initializeApp, getApps } from "firebase-admin/app";

// Theoria institutional operations: server-enforced authority, transactional writes,
// and append-only administrative history. Existing legacy data is read, not migrated destructively.
if (!getApps().length) initializeApp();
const db = getFirestore();
const timestamp = () => FieldValue.serverTimestamp();
const id = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const text = (value, max = 180) => String(value ?? "").trim().slice(0, max);
const failure = (code, message) => { throw new HttpsError(code, message); };
const needed = (condition, message, code = "failed-precondition") => { if (!condition) failure(code, message); };
const auth = request => {
  const uid = request.auth?.uid;
  needed(!!uid, "Sign in to Theoria.", "unauthenticated");
  return uid;
};
const instRef = institutionId => db.doc("institutions/" + institutionId);
const ref = (institutionId, path, key) => instRef(institutionId).collection(path).doc(key);
const audit = (tx, institutionId, actor, action, details = {}) => {
  tx.create(instRef(institutionId).collection("auditEvents").doc(), {
    createdAt: timestamp(), createdBy: actor, action, ...details
  });
};
const roles = {
  school: new Set(["principal", "assistant_principal", "district_admin", "registrar"]),
  district: new Set(["district_admin", "principal"]),
  admissions: new Set(["principal", "assistant_principal", "district_admin", "registrar"]),
  faculty: new Set(["principal", "district_admin"]),
  policy: new Set(["principal", "district_admin"]),
  records: new Set(["principal", "assistant_principal", "district_admin", "registrar"])
};
async function access(read, uid, institutionId) {
  needed(id(institutionId), "Invalid institution identifier.", "invalid-argument");
  const i = instRef(institutionId);
  const [snapshot, staff] = await Promise.all([read(i), read(ref(institutionId, "staff", uid))]);
  needed(snapshot.exists, "Institution does not exist.", "not-found");
  const institution = snapshot.data();
  let role = institution.ownerUid === uid ? "owner" : staff.exists ? staff.data().role : "";
  // District scope must be accepted by BOTH institution owners, never inherited
  // from a client-controlled parentDistrictId alone.
  if (!role && institution.kind === "school" && id(institution.parentDistrictId)) {
    const districtId = institution.parentDistrictId;
    const [link, parent, parentStaff] = await Promise.all([
      read(ref(institutionId, "districtLinks", districtId)),
      read(instRef(districtId)),
      read(ref(districtId, "staff", uid))
    ]);
    if (link.exists && link.data().status === "active" && parent.exists) {
      if (parent.data().ownerUid === uid) role = "district_owner";
      else if (roles.district.has(parentStaff.data()?.role)) role = "district_admin";
    }
  }
  return { institution, role, institutionId };
}
function allow(context, capability) {
  const role = context.role;
  needed(role === "owner" || role === "district_owner" || roles[capability]?.has(role),
    "You are not authorized to perform this action.", "permission-denied");
}
const options = { region: "us-central1", maxInstances: 10, enforceAppCheck: false };
const serial = snap => snap.docs.map(doc => {
  const data = doc.data();
  // Return only the fields required by the authenticated workspace.
  return { id: doc.id, ...data };
});
const list = (institutionId, name, count = 80) =>
  instRef(institutionId).collection(name).limit(count).get().then(serial);
const profile = async studentUid => {
  needed(id(studentUid), "Invalid student identifier.", "invalid-argument");
  const s = await db.doc("users/" + studentUid).get();
  needed(s.exists && s.data().role === "student", "The account must be an existing student.", "failed-precondition");
  return { uid: studentUid, studentName: text(s.data().displayName || "Student", 100) };
};
async function eligibleEntrance(tx, section, studentUid, course) {
  if (Array.isArray(course.prerequisiteCourseIds) && course.prerequisiteCourseIds.length)
    failure("failed-precondition", "This course has prerequisites requiring a separate academic eligibility review.");
  if (Array.isArray(course.progressionRequirements) && course.progressionRequirements.length)
    failure("failed-precondition", "This course has progression requirements requiring a separate academic eligibility review.");
  const progression = course.prerequisitePolicy || {};
  if ((Array.isArray(progression.requiredCourseIds) && progression.requiredCourseIds.length) ||
      (Array.isArray(progression.competencyRequirements) && progression.competencyRequirements.length) ||
      progression.instructorApproval === true)
    failure("failed-precondition",
      "Course progression requirements must be certified by the instructor before institutional placement.");
  if (course.entranceExamRequired !== true && section.entranceExamRequired !== true) return;
  needed(id(section.entranceAssessmentId), "Entrance assessment is not configured.");
  const [candidate, result] = await Promise.all([
    tx.get(db.doc("sections/" + section.id + "/entranceCandidates/" + studentUid)),
    tx.get(db.doc("assessments/" + section.entranceAssessmentId + "/results/" + studentUid))
  ]);
  needed(candidate.exists && candidate.data().status === "passed" &&
    candidate.data().assessmentId === section.entranceAssessmentId &&
    result.exists && result.data().complete === true &&
    Number(result.data().percent) >= Number(section.entrancePassPercent || 70),
    "Entrance assessment has not been passed and authorized.");
}
async function registrationTransaction(actor, institutionId, studentUid, offeringId, sectionId) {
  return db.runTransaction(async tx => {
    const ctx = await access(doc => tx.get(doc), actor, institutionId);
    allow(ctx, "admissions");
    needed(ctx.institution.status === "active" && ctx.institution.kind === "school", "School is not active.");
    const student = await tx.get(db.doc("users/" + studentUid));
    needed(student.exists && student.data().role === "student", "Student account not found.");
    const offeringRef = ref(institutionId, "offerings", offeringId);
    const requestRef = ref(institutionId, "requests", offeringId + "_" + studentUid);
    const registrationRef = ref(institutionId, "registrations", offeringId + "_" + studentUid);
    const scheduleRef = ref(institutionId, "studentSchedules", studentUid);
    const enrollmentRef = ref(institutionId, "academicEnrollments", studentUid);
    const sectionRef = db.doc("sections/" + sectionId);
    const memberRef = sectionRef.collection("members").doc(studentUid);
    const userEnrollmentRef = db.doc("users/" + studentUid + "/enrollments/" + sectionId);
    const [member, offeringDoc, registration, sectionDoc, courseRequest, schedule, enrollment, sectionMember] =
      await Promise.all([
        tx.get(ref(institutionId, "members", studentUid)), tx.get(offeringRef), tx.get(registrationRef),
        tx.get(sectionRef), tx.get(requestRef), tx.get(scheduleRef), tx.get(enrollmentRef), tx.get(memberRef)
      ]);
    needed(member.exists && member.data().status === "active", "Student must be admitted to this school.");
    needed(offeringDoc.exists && offeringDoc.data().published === true, "Course offering is unavailable.");
    const offering = offeringDoc.data();
    needed(offering.sectionId === sectionId, "The offering must be linked to this section.");
    needed(sectionDoc.exists && sectionDoc.data().courseId === offering.courseId, "Section and course do not match.");
    needed(!registration.exists || registration.data().status !== "active", "Student is already registered.");
    needed(!sectionMember.exists || sectionMember.data().status !== "enrolled", "Student is already enrolled in the section.");
    const courseRef = db.doc("courses/" + offering.courseId);
    const courseDoc = await tx.get(courseRef);
    needed(courseDoc.exists, "Course does not exist.");
    const section = { id: sectionId, ...sectionDoc.data() };
    await eligibleEntrance(tx, section, studentUid, courseDoc.data());
    const entries = schedule.exists ? (schedule.data().entries || {}) : {};
    const conflict = Object.entries(entries).find(([key, entry]) =>
      key !== offeringId && entry.status === "active" && entry.term === offering.term &&
      offering.period && entry.period && entry.period === offering.period);
    needed(!conflict, "Student has a class scheduled during this period.");
    const seats = Number(offering.seatsTaken || 0);
    const cap = Number(offering.capacity || 0);
    needed(!cap || seats < cap, "No remaining seats in this offering.");
    const currentYear = text(offering.term || "Unassigned", 80);
    const displayName = text(student.data().displayName || member.data().studentName || "Student", 100);
    const now = timestamp();
    tx.set(registrationRef, {
      offeringId, sectionId, studentUid, studentName: displayName, term: currentYear,
      status: "active", enrolledBy: actor, enrolledAt: now, updatedAt: now
    });
    const preferences = sectionMember.data()?.accommodations ||
      student.data().defaultAccommodations || {};
    tx.set(memberRef, {
      userId: studentUid, displayName, email: student.data().email || "",
      role: "student", status: "enrolled", joinedAt: now,
      useProfileDefaults: true, accommodations: {
        timeMultiplier: Number.isFinite(Number(preferences.timeMultiplier)) ?
          Math.min(4, Math.max(1, Number(preferences.timeMultiplier))) : 1,
        breaks: preferences.breaks === true,
        calculator: preferences.calculator === true,
        largeText: preferences.largeText === true,
        reducedDistractions: preferences.reducedDistractions === true,
        notes: text(preferences.notes, 500)
      }
    }, { merge: true });
    tx.set(userEnrollmentRef, {
      sectionId, courseId: offering.courseId, courseCode: offering.code || "",
      courseTitle: offering.title || "", sectionName: section.sectionName || "",
      term: currentYear, joinCode: section.joinCode || "",
      status: "Enrolled", joinedAt: now, updatedAt: now
    }, { merge: true });
    tx.set(scheduleRef, { entries: { ...entries, [offeringId]: {
      status: "active", offeringId, sectionId, term: offering.term || "", period: offering.period || ""
    } }, updatedAt: now }, { merge: true });
    tx.update(offeringRef, { seatsTaken: seats + 1 });
    if (courseRequest.exists && courseRequest.data().status === "pending")
      tx.update(requestRef, { status: "approved", reviewedBy: actor, reviewedAt: now });
    tx.set(ref(institutionId, "placements", offeringId + "_" + studentUid), {
      studentUid, studentName: displayName, offeringId, sectionReference: section.joinCode || "",
      status: "placed", directEnrollment: true, approvedRequestId: offeringId + "_" + studentUid, placedBy: actor, placedAt: now
    }, { merge: true });
    if (!enrollment.exists) tx.set(enrollmentRef, {
      studentUid, studentName: displayName, status: "active",
      academicYear: currentYear, admittedAt: now, updatedAt: now
    });
    audit(tx, institutionId, actor, "course_registered", { studentUid, offeringId, sectionId });
    return { studentUid, offeringId, sectionId, status: "active" };
  });
}

export const institutionSnapshot = onCall(options, async request => {
  const uid = auth(request), institutionId = request.data?.institutionId;
  needed(id(institutionId), "Choose an institution.", "invalid-argument");
  const ctx = await access(doc => doc.get(), uid, institutionId);
  allow(ctx, "school");
  const settingsRef = ref(institutionId, "institutionSettings", "general");
  const settings = await settingsRef.get();
  const names = ["members", "applications", "requests", "offerings", "registrations", "staff",
    "invitations", "terms", "departments", "studentRecords", "auditEvents", "academicEnrollments",
    "districtRequests"];
  const results = await Promise.all(names.map(name => list(institutionId, name)));
  const collections = Object.fromEntries(names.map((name, i) => [name, results[i]]));
  let schools = [];
  if (ctx.institution.kind === "district") {
    const all = await db.collection("institutions").where("parentDistrictId", "==", institutionId).limit(100).get();
    schools = serial(all);
  }
  return { institution: { id: institutionId, ...ctx.institution }, settings: settings.exists ? settings.data() : {}, role: ctx.role, schools, ...collections,
    limits: { perCollection: 80, schools: 100 } };
});

export const institutionCommand = onCall(options, async request => {
  const actor = auth(request);
  const data = request.data || {}, action = text(data.action, 50), institutionId = data.institutionId;
  needed(id(institutionId), "Choose an institution.", "invalid-argument");
  const i = instRef(institutionId);
  if (action === "apply") {
    const student = await profile(actor);
    return db.runTransaction(async tx => {
      const institution = await tx.get(i);
      needed(institution.exists && institution.data().kind === "school" &&
        institution.data().status === "active", "Applications require an active school.");
      const application = ref(institutionId, "applications", actor);
      const membership = ref(institutionId, "members", actor);
      const enrollmentRef = ref(institutionId, "academicEnrollments", actor);
      const setting = await tx.get(ref(institutionId, "institutionSettings", "general"));
      needed(setting.data()?.allowStudentApplications !== false,
        "The school has closed student applications.", "permission-denied");
      const existing = await tx.get(application);
      const member = await tx.get(membership);
      const previousEnrollment = await tx.get(enrollmentRef);
      needed(!member.exists || member.data().status !== "active", "You are already enrolled.");
      needed(!existing.exists || existing.data().status !== "pending", "An application is already pending.");
      const now = timestamp();
      const automatic = setting.exists && setting.data().requireAdmissionsReview === false;
      tx.set(application, {
        ...student, gradeLevel: text(data.gradeLevel, 40), program: text(data.program, 120),
        notes: text(data.notes, 1500), status: automatic ? "approved" : "pending",
        createdAt: now, updatedAt: now,
        ...(automatic ? { reviewedBy: "institution_policy", reviewedAt: now } : {})
      });
      if (automatic) {
        tx.set(membership, { ...student, status: "active", requestedAt: now,
          reviewedBy: "institution_policy", reviewedAt: now }, { merge: true });
        if (!previousEnrollment.exists) tx.create(enrollmentRef, {
          ...student, status: "active", gradeLevel: text(data.gradeLevel, 40),
          program: text(data.program, 120), academicYear: "", admittedAt: now, updatedAt: now
        });
        audit(tx, institutionId, actor, "policy_auto_admission", { studentUid: actor });
      }
      return { status: automatic ? "active" : "pending" };
    });
  }
  if (action === "acceptInvitation") {
    const invitation = text(data.email || request.auth.token.email, 200).toLowerCase();
    needed(invitation === String(request.auth.token.email || "").toLowerCase(),
      "Invitation must match your verified sign-in email.", "permission-denied");
    return db.runTransaction(async tx => {
      const invite = await tx.get(ref(institutionId, "invitations", invitation));
      needed(invite.exists && invite.data().status === "pending", "No pending invitation.");
      const staff = ref(institutionId, "staff", actor);
      const existing = await tx.get(staff);
      needed(!existing.exists, "You already have a staff assignment.");
      tx.set(staff, {
        uid: actor, email: invitation, displayName: text(request.auth.token.name || invitation, 100),
        role: invite.data().role, assignedBy: invite.data().invitedBy, assignedAt: timestamp()
      });
      tx.update(invite.ref, { status: "accepted", acceptedBy: actor, acceptedAt: timestamp() });
      return { status: "accepted" };
    });
  }
  if (action === "register" || action === "bulkRegister") {
    const items = action === "register"
      ? [{ studentUid: data.studentUid, offeringId: data.offeringId }]
      : Array.isArray(data.items) ? data.items : [];
    needed(items.length > 0 && items.length <= 25, "Register between 1 and 25 students.", "invalid-argument");
    const result = [];
    for (const entry of items) {
      try {
        needed(id(entry.studentUid) && id(entry.offeringId), "Invalid student or offering.", "invalid-argument");
        const offering = await ref(institutionId, "offerings", entry.offeringId).get();
        needed(offering.exists && id(offering.data().sectionId), "Offering must be linked to a live section.");
        const value = await registrationTransaction(actor, institutionId, entry.studentUid, entry.offeringId, offering.data().sectionId);
        result.push({ ok: true, ...value });
      } catch (error) {
        if (action === "register") throw error;
        result.push({ ok: false, studentUid: entry.studentUid, offeringId: entry.offeringId,
          message: error.message || "Unable to enroll." });
      }
    }
    return { results: result, partial: result.some(x => !x.ok) };
  }
  return db.runTransaction(async tx => {
    const ctx = await access(doc => tx.get(doc), actor, institutionId);
    const now = timestamp();
    if (action === "createOffering") {
      allow(ctx, "admissions");
      needed(ctx.institution.kind === "school" && ctx.institution.status === "active",
        "Publish offerings from an active school.");
      needed(id(data.courseId), "Choose an official Theoria catalog course.", "invalid-argument");
      const course = await tx.get(db.doc("courses/" + data.courseId));
      needed(course.exists && course.data().catalogCourse === true &&
        course.data().catalogPublished === true && course.data().status !== "Archived",
        "Only officially published catalog courses may be offered.");
      const term = text(data.term, 80), openDate = text(data.openDate, 10),
        closeDate = text(data.closeDate, 10);
      needed(term.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(openDate) &&
        /^\d{4}-\d{2}-\d{2}$/.test(closeDate) && openDate <= closeDate,
        "Provide a term and a valid registration window.", "invalid-argument");
      const start = new Date(openDate + "T00:00:00Z");
      const end = new Date(Date.parse(closeDate + "T00:00:00Z") + 86400000);
      needed(Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()),
        "Invalid calendar dates.", "invalid-argument");
      const offeringDoc = i.collection("offerings").doc();
      tx.create(offeringDoc, {
        courseId: data.courseId, title: course.data().title,
        code: course.data().code || "", term,
        description: text(course.data().description, 1000),
        openDate, closeDate, openAt: start, closeAt: end,
        published: true, createdBy: actor, createdAt: now
      });
      audit(tx, institutionId, actor, "school_offering_created", { offeringId: offeringDoc.id });
      return { offeringId: offeringDoc.id };
    }
    if (action === "createTerm") {
      allow(ctx, "policy");
      const title = text(data.title, 120), startDate = text(data.startDate, 10), endDate = text(data.endDate, 10);
      needed(title.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
        /^\d{4}-\d{2}-\d{2}$/.test(endDate) && startDate <= endDate,
        "Provide a valid title and date range.", "invalid-argument");
      tx.create(i.collection("terms").doc(), {
        title, startDate, endDate, gradingScheme: "standard", createdBy: actor, createdAt: now
      });
      audit(tx, institutionId, actor, "academic_term_created");
      return { created: true };
    }
    if (action === "createDepartment") {
      allow(ctx, "policy");
      const name = text(data.name, 120);
      needed(name.length >= 2, "Department name required.", "invalid-argument");
      tx.create(i.collection("departments").doc(), {
        name, description: text(data.description, 500), createdBy: actor, createdAt: now
      });
      audit(tx, institutionId, actor, "academic_department_created");
      return { created: true };
    }
    if (action === "archiveInstitution") {
      needed(ctx.role === "owner", "Only an institution owner can archive it.", "permission-denied");
      needed(ctx.institution.status === "active", "Institution is already archived.");
      tx.update(i, { status: "archived", archivedBy: actor, archivedAt: now });
      audit(tx, institutionId, actor, "institution_archived");
      return { archived: true };
    }
    if (action === "removeStaff") {
      needed(ctx.role === "owner", "Only the owner may remove staff.", "permission-denied");
      needed(id(data.staffUid) && data.staffUid !== actor, "Choose a non-owner staff member.", "invalid-argument");
      const staffRef = ref(institutionId, "staff", data.staffUid);
      const staff = await tx.get(staffRef);
      needed(staff.exists, "Staff assignment not found.");
      tx.delete(staffRef);
      audit(tx, institutionId, actor, "staff_role_revoked", { staffUid: data.staffUid });
      return { revoked: true };
    }
    if (action === "createSchool") {
      needed(ctx.institution.kind === "district" && ctx.role === "owner",
        "Only the district owner may create schools.", "permission-denied");
      const name = text(data.name, 100);
      needed(name.length >= 3, "Name must have at least 3 characters.", "invalid-argument");
      const schoolDoc = db.collection("institutions").doc();
      tx.create(schoolDoc, {
        name, kind: "school", description: text(data.description, 750),
        parentDistrictId: institutionId, ownerUid: ctx.institution.ownerUid,
        status: "active", verified: false, createdAt: now
      });
      tx.create(schoolDoc.collection("districtLinks").doc(institutionId), {
        districtId: institutionId, status: "active", acceptedBy: actor, acceptedAt: now
      });
      audit(tx, institutionId, actor, "district_school_created", { schoolId: schoolDoc.id });
      return { schoolId: schoolDoc.id };
    }
    if (action === "transferStudent") {
      allow(ctx, "admissions");
      needed(ctx.institution.kind === "school" && id(data.destinationId) &&
        data.destinationId !== institutionId, "Choose a different destination school.", "invalid-argument");
      needed(id(data.studentUid), "Choose a student.", "invalid-argument");
      const dest = await access(doc => tx.get(doc), actor, data.destinationId);
      allow(dest, "admissions");
      needed(dest.institution.kind === "school" && dest.institution.status === "active",
        "Destination school must be active.");
      const sourceMember = ref(institutionId, "members", data.studentUid);
      const sourceEnroll = ref(institutionId, "academicEnrollments", data.studentUid);
      const destinationMember = ref(data.destinationId, "members", data.studentUid);
      const destinationEnroll = ref(data.destinationId, "academicEnrollments", data.studentUid);
      const sourceSchedule = ref(institutionId, "studentSchedules", data.studentUid);
      const [from, prior, to, targetPrior, schedule] = await Promise.all([
        tx.get(sourceMember), tx.get(sourceEnroll), tx.get(destinationMember),
        tx.get(destinationEnroll), tx.get(sourceSchedule)
      ]);
      needed(from.exists && from.data().status === "active", "Student has no active source enrollment.");
      needed(!to.exists || to.data().status !== "active", "Student already attends the destination.");
      const entries = schedule.data()?.entries || {};
      needed(!Object.values(entries).some(e => e.status === "active"),
        "Withdraw active course registrations before transferring schools.");
      const studentName = text(from.data().studentName || prior.data()?.studentName || "Student", 100);
      tx.update(sourceMember, { status: "transferred", transferredTo: data.destinationId,
        transferredBy: actor, transferredAt: now });
      if (prior.exists) tx.update(sourceEnroll, { status: "transferred", updatedAt: now });
      tx.set(destinationMember, { studentUid: data.studentUid, studentName,
        status: "active", requestedAt: now, reviewedBy: actor, reviewedAt: now }, { merge: true });
      tx.set(destinationEnroll, { studentUid: data.studentUid, studentName,
        status: "active", academicYear: text(data.academicYear, 80),
        gradeLevel: text(data.gradeLevel, 40), transferredFrom: institutionId,
        admittedAt: now, updatedAt: now }, { merge: true });
      audit(tx, institutionId, actor, "student_transferred_out",
        { studentUid: data.studentUid, destinationId: data.destinationId });
      audit(tx, data.destinationId, actor, "student_transferred_in",
        { studentUid: data.studentUid, sourceId: institutionId });
      return { transferred: true };
    }
    if (action === "updateInstitution") {
      allow(ctx, "policy");
      needed(ctx.role === "owner" || ctx.role === "district_owner",
        "Only the institution owner can change institutional identity.", "permission-denied");
      const name = text(data.name, 100), description = text(data.description, 750);
      needed(name.length >= 3, "Institution name must be at least three characters.", "invalid-argument");
      tx.update(i, { name, description, updatedAt: now });
      audit(tx, institutionId, actor, "institution_updated");
      return { updated: true };
    }
    if (action === "setSetting") {
      allow(ctx, "policy");
      const updates = {
        requireAdmissionsReview: data.requireAdmissionsReview !== false,
        allowStudentApplications: data.allowStudentApplications !== false,
        admissionInstructions: text(data.admissionInstructions, 600),
        registrationOpen: data.registrationOpen === true,
        updatedBy: actor, updatedAt: now
      };
      tx.set(ref(institutionId, "institutionSettings", "general"), updates, { merge: true });
      audit(tx, institutionId, actor, "institution_policy_updated");
      return { updated: true };
    }
    if (action === "decideAdmission" || action === "decideMembership") {
      allow(ctx, "admissions");
      const studentUid = data.studentUid;
      needed(id(studentUid), "Invalid student.", "invalid-argument");
      const approve = data.decision === "approve";
      needed(approve || data.decision === "decline", "Choose approve or decline.", "invalid-argument");
      const applicationRef = ref(institutionId, "applications", studentUid);
      const memberRef = ref(institutionId, "members", studentUid);
      const enrollRef = ref(institutionId, "academicEnrollments", studentUid);
      const [application, membership, enrollment, student] = await Promise.all([
        tx.get(applicationRef), tx.get(memberRef), tx.get(enrollRef), tx.get(db.doc("users/" + studentUid))
      ]);
      needed(student.exists && student.data().role === "student", "Student account does not exist.");
      if (action === "decideAdmission") needed(application.exists && application.data().status === "pending", "No pending application.");
      else needed(membership.exists && membership.data().status === "pending", "No pending membership.");
      const studentName = text(student.data().displayName || application.data()?.studentName || membership.data()?.studentName || "Student", 100);
      if (application.exists && application.data().status === "pending")
        tx.update(applicationRef, { status: approve ? "approved" : "declined", reviewedBy: actor, reviewedAt: now });
      if (membership.exists) tx.update(memberRef, {
        status: approve ? "active" : "declined", reviewedBy: actor, reviewedAt: now
      });
      else tx.create(memberRef, { studentUid, studentName, status: approve ? "active" : "declined",
        requestedAt: now, reviewedBy: actor, reviewedAt: now });
      if (approve) {
        if (!enrollment.exists) tx.create(enrollRef, {
          studentUid, studentName, status: "active", academicYear: text(data.academicYear, 80),
          gradeLevel: text(application.data()?.gradeLevel || data.gradeLevel, 40),
          program: text(application.data()?.program, 120),
          admittedAt: now, updatedAt: now
        });
        else tx.update(enrollRef, { status: "active", updatedAt: now });
      }
      audit(tx, institutionId, actor, approve ? "admission_approved" : "admission_declined", { studentUid });
      return { studentUid, status: approve ? "active" : "declined" };
    }
    if (action === "decideRequest") {
      allow(ctx, "admissions");
      needed(id(data.requestId), "Invalid request.", "invalid-argument");
      const requestRef = ref(institutionId, "requests", data.requestId);
      const current = await tx.get(requestRef);
      needed(current.exists && current.data().status === "pending", "Request is no longer pending.");
      needed(["approved", "declined"].includes(data.decision), "Invalid decision.", "invalid-argument");
      tx.update(requestRef, { status: data.decision, reviewedBy: actor, reviewedAt: now });
      audit(tx, institutionId, actor, "course_request_" + data.decision,
        { studentUid: current.data().studentUid, offeringId: current.data().offeringId });
      return { status: data.decision };
    }
    if (action === "inviteStaff") {
      allow(ctx, "faculty");
      const email = text(data.email, 200).toLowerCase();
      const role = text(data.role, 40);
      needed(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Invalid staff email.", "invalid-argument");
      needed(["principal", "assistant_principal", "district_admin", "registrar", "counselor",
        "department_head", "instructor", "staff"].includes(role), "Invalid staff role.");
      // Only owners may delegate their highest privileged roles.
      if (["principal", "district_admin"].includes(role))
        needed(ctx.role === "owner", "Only the institution owner may appoint leadership.", "permission-denied");
      tx.set(ref(institutionId, "invitations", email), {
        email, role, status: "pending", invitedBy: actor, invitedAt: now
      });
      audit(tx, institutionId, actor, "staff_invited", { role });
      return { invited: true };
    }
    if (action === "linkOffering") {
      allow(ctx, "admissions");
      needed(id(data.offeringId) && id(data.sectionId), "Choose a course and section.", "invalid-argument");
      const offeringRef = ref(institutionId, "offerings", data.offeringId);
      const sectionRef = db.doc("sections/" + data.sectionId);
      const [offer, section] = await Promise.all([tx.get(offeringRef), tx.get(sectionRef)]);
      needed(offer.exists && section.exists, "Offering or section not found.");
      needed(offer.data().courseId === section.data().courseId, "The section must teach the published course.");
      needed(!section.data().institutionId ||
        (section.data().institutionId === institutionId &&
         section.data().institutionOfferingId === data.offeringId),
        "This section is already linked to another institutional offering.");
      const owner = section.data().ownerId;
      needed(id(owner), "Section has no valid instructor.");
      const ownerStaff = await tx.get(ref(institutionId, "staff", owner));
      needed(owner === ctx.institution.ownerUid || ownerStaff.exists,
        "The section instructor must belong to this institution.");
      needed(!offer.data().sectionId || offer.data().sectionId === data.sectionId,
        "Existing section link must be preserved while enrollments exist.");
      const currentMembers = await tx.get(sectionRef.collection("members").limit(10001));
      needed(currentMembers.size <= 10000, "Section exceeds supported roster size.");
      const existingSeats = currentMembers.docs.filter(s => s.data().status === "enrolled").length;
      const capacity = Number(offer.data().capacity || 0);
      needed(!capacity || existingSeats <= capacity, "Existing roster exceeds offering capacity.");
      tx.update(sectionRef, { institutionId, institutionOfferingId: data.offeringId,
        institutionLinkedAt: now });
      tx.update(offeringRef, { sectionId: data.sectionId, seatsTaken: existingSeats,
        sectionLinkedBy: actor, sectionLinkedAt: now });
      audit(tx, institutionId, actor, "offering_section_linked",
        { offeringId: data.offeringId, sectionId: data.sectionId });
      return { linked: true, seatsTaken: existingSeats };
    }
    if (action === "withdraw") {
      allow(ctx, "admissions");
      needed(id(data.studentUid) && id(data.offeringId), "Invalid registration.", "invalid-argument");
      const key = data.offeringId + "_" + data.studentUid;
      const regRef = ref(institutionId, "registrations", key);
      const offeringRef = ref(institutionId, "offerings", data.offeringId);
      const scheduleRef = ref(institutionId, "studentSchedules", data.studentUid);
      const [registration, offering, schedule] = await Promise.all([
        tx.get(regRef), tx.get(offeringRef), tx.get(scheduleRef)
      ]);
      needed(registration.exists && registration.data().status === "active", "No active course registration.");
      const sectionId = registration.data().sectionId;
      const memberRef = db.doc("sections/" + sectionId + "/members/" + data.studentUid);
      const personalRef = db.doc("users/" + data.studentUid + "/enrollments/" + sectionId);
      const entries = schedule.exists ? (schedule.data().entries || {}) : {};
      tx.update(regRef, { status: "withdrawn", updatedAt: now, withdrawnBy: actor });
      tx.set(memberRef, { status: "withdrawn" }, { merge: true });
      tx.set(personalRef, { status: "Withdrawn", updatedAt: now }, { merge: true });
      tx.set(scheduleRef, { entries: { ...entries, [data.offeringId]: {
        ...(entries[data.offeringId] || {}), status: "withdrawn"
      } }, updatedAt: now }, { merge: true });
      if (offering.exists) tx.update(offeringRef, { seatsTaken: Math.max(0, Number(offering.data().seatsTaken || 0) - 1) });
      audit(tx, institutionId, actor, "course_withdrawn", { studentUid: data.studentUid, offeringId: data.offeringId });
      return { withdrawn: true };
    }
    if (action === "rollover") {
      allow(ctx, "admissions");
      needed(id(data.studentUid), "Choose a student.", "invalid-argument");
      const year = text(data.academicYear, 80);
      needed(year.length >= 4, "Academic year is required.", "invalid-argument");
      const enrollRef = ref(institutionId, "academicEnrollments", data.studentUid);
      const current = await tx.get(enrollRef);
      needed(current.exists && current.data().status === "active", "Student not enrolled.");
      const oldYear = text(current.data().academicYear || "Legacy", 80);
      needed(oldYear !== year, "Student is already assigned to this academic year.");
      const historyRef = ref(institutionId, "academicYearHistory",
        data.studentUid + "_" + oldYear.replace(/[^A-Za-z0-9_-]/g, "_"));
      const historic = await tx.get(historyRef);
      if (!historic.exists) tx.create(historyRef, { studentUid: data.studentUid,
        academicYear: oldYear, gradeLevel: current.data().gradeLevel || "",
        program: current.data().program || "", archivedAt: now, archivedBy: actor });
      tx.update(enrollRef, { academicYear: year, gradeLevel: text(data.gradeLevel, 40),
        updatedAt: now });
      audit(tx, institutionId, actor, "academic_year_rolled_over", { studentUid: data.studentUid, academicYear: year });
      return { rolledOver: true };
    }
    if (action === "requestDistrictLink") {
      needed(ctx.role === "owner" && ctx.institution.kind === "school",
        "Only the school owner may request a district affiliation.", "permission-denied");
      needed(id(data.districtId), "Choose a district.", "invalid-argument");
      const district = await tx.get(instRef(data.districtId));
      needed(district.exists && district.data().kind === "district", "District not found.");
      const requestRef = ref(data.districtId, "districtRequests", institutionId);
      tx.set(requestRef, { schoolId: institutionId, schoolName: ctx.institution.name,
        status: "pending", requestedBy: actor, requestedAt: now });
      audit(tx, institutionId, actor, "district_affiliation_requested", { districtId: data.districtId });
      return { pending: true };
    }
    if (action === "approveDistrictLink") {
      needed(ctx.institution.kind === "district" && (ctx.role === "owner" || ctx.role === "district_admin"),
        "Only district leadership can accept school affiliations.", "permission-denied");
      needed(id(data.schoolId), "Choose school.", "invalid-argument");
      const requestRef = ref(institutionId, "districtRequests", data.schoolId);
      const schoolRef = instRef(data.schoolId);
      const [pending, school] = await Promise.all([tx.get(requestRef), tx.get(schoolRef)]);
      needed(pending.exists && pending.data().status === "pending" && school.exists &&
        school.data().kind === "school", "No valid school affiliation request.");
      needed(!school.data().parentDistrictId || school.data().parentDistrictId === institutionId,
        "School already belongs to a different district.");
      tx.update(requestRef, { status: "approved", reviewedBy: actor, reviewedAt: now });
      tx.set(ref(data.schoolId, "districtLinks", institutionId), {
        districtId: institutionId, status: "active", acceptedBy: actor, acceptedAt: now
      });
      tx.update(schoolRef, { parentDistrictId: institutionId, updatedAt: now });
      audit(tx, institutionId, actor, "school_affiliation_approved", { schoolId: data.schoolId });
      return { linked: true };
    }
    failure("invalid-argument", "Unknown institutional command.");
  });
});
