import test from "node:test";
import assert from "node:assert/strict";
import { mayManageResult, mayReleaseResult, isSafeDocumentId } from "./academic-policy.js";

test("owner and delegated graders can manage results", () => {
  const assessment = { ownerId: "teacher", sectionId: "section" };
  assert.equal(mayManageResult("teacher", assessment, null, null), true);
  assert.equal(mayManageResult("owner", assessment, { ownerId: "owner" }, null), true);
  assert.equal(mayManageResult("grader", assessment, { ownerId: "owner" }, { role: "grader" }), true);
  assert.equal(mayManageResult("learner", assessment, { ownerId: "owner" }, { role: "student" }), false);
  assert.equal(mayManageResult("outsider", assessment, null, null), false);
  assert.equal(mayManageResult("observer", assessment, { ownerId: "owner" }, { role: "observer" }), false);
});

test("only complete results can be released, but existing releases can be revoked", () => {
  assert.equal(mayReleaseResult({ complete: true }, true), true);
  assert.equal(mayReleaseResult({ complete: false }, true), false);
  assert.equal(mayReleaseResult({ complete: false }, false), true);
  assert.equal(mayReleaseResult(null, false), false);
  assert.equal(mayReleaseResult({ complete: true }, "true"), false);
});

test("reject invalid Firestore path components", () => {
  assert.equal(isSafeDocumentId("7k4M2_studentA"), true);
  assert.equal(isSafeDocumentId("../users"), false);
  assert.equal(isSafeDocumentId("."), false);
  assert.equal(isSafeDocumentId(""), false);
});
