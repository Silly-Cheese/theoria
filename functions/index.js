import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { mayManageResult, mayReleaseResult, isSafeDocumentId } from "./academic-policy.js";

if (!getApps().length) initializeApp();
const db = getFirestore();

function requireUser(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Sign in to Theoria to continue.");
  return request.auth.uid;
}

// Atomic, auditable instructor control of assessment-result visibility.
// Uses server-side authorization; caller-provided role, grade and section IDs are never trusted.
export const setAssessmentResultVisibility = onCall(
  { region: "us-central1", maxInstances: 10 },
  async request => {
    const uid = requireUser(request);
    const { assessmentId, studentId, released } = request.data || {};
    if (!isSafeDocumentId(assessmentId) || !isSafeDocumentId(studentId) || typeof released !== "boolean") {
      throw new HttpsError("invalid-argument", "Provide a valid assessment, student and visibility.");
    }
    const assessmentRef = db.doc("assessments/" + assessmentId);
    const resultRef = assessmentRef.collection("results").doc(studentId);
    const auditRef = db.collection("systemAcademicAudit").doc();
    return db.runTransaction(async tx => {
      const assessmentSnap = await tx.get(assessmentRef);
      if (!assessmentSnap.exists) throw new HttpsError("not-found", "The assessment no longer exists.");
      const assessment = assessmentSnap.data();
      const resultSnap = await tx.get(resultRef);
      if (!resultSnap.exists) throw new HttpsError("not-found", "No graded result exists for this student.");
      let section = null, staff = null, gradeRef = null, gradeSnap = null;
      if (assessment.sectionId) {
        if (!isSafeDocumentId(assessment.sectionId)) throw new HttpsError("failed-precondition", "Invalid assessment section.");
        const sectionRef = db.doc("sections/" + assessment.sectionId);
        const staffRef = sectionRef.collection("staff").doc(uid);
        const [sectionDoc, staffDoc] = await Promise.all([tx.get(sectionRef), tx.get(staffRef)]);
        section = sectionDoc.exists ? sectionDoc.data() : null;
        staff = staffDoc.exists ? staffDoc.data() : null;
        if (!assessment.entranceExam) {
          gradeRef = sectionRef.collection("assessmentGrades").doc(assessmentId + "_" + studentId);
          gradeSnap = await tx.get(gradeRef);
        }
      }
      if (!mayManageResult(uid, assessment, section, staff)) {
        throw new HttpsError("permission-denied", "Only the authorized assessment instructor or grader can release results.");
      }
      if (!mayReleaseResult(resultSnap.data(), released)) {
        throw new HttpsError("failed-precondition", "Finish grading before releasing a result.");
      }
      const previousReleased = resultSnap.data().released === true;
      if (previousReleased === released) return { released, changed: false };
      const now = FieldValue.serverTimestamp();
      tx.update(resultRef, { released, updatedAt: now, releaseChangedBy: uid });
      if (gradeRef && gradeSnap?.exists) tx.update(gradeRef, { released, updatedAt: now });
      tx.create(auditRef, {
        action: released ? "assessment_result_released" : "assessment_result_unreleased",
        assessmentId, sectionId: assessment.sectionId || null, studentId,
        actorUid: uid, previousReleased, released, createdAt: now
      });
      return { released, changed: true };
    });
  }
);
