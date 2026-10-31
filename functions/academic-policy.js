// Pure academic policy predicates shared by callable handlers and Node tests.
export const GRADING_STAFF_ROLES = Object.freeze(["coordinator", "teaching_assistant", "grader"]);

export function mayManageResult(uid, assessment, section, staff) {
  if (!uid || !assessment) return false;
  if (assessment.ownerId === uid) return true;
  if (!assessment.sectionId || !section) return false;
  return section.ownerId === uid || (staff && GRADING_STAFF_ROLES.includes(staff.role));
}

export function mayReleaseResult(result, released) {
  return Boolean(result) && typeof released === "boolean" &&
    (!released || result.complete === true);
}

export function isSafeDocumentId(id) {
  return typeof id === "string" && id.length >= 1 && id.length <= 128 &&
    !id.includes("/") && id !== "." && id !== "..";
}
