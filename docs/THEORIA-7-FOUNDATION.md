# Theoria 7.0 — Foundation overhaul (review branch)

## Scope delivered
- Server-side Firebase callable `setAssessmentResultVisibility`, using authenticated instructor / authorized grading staff checks, a Firestore transaction, grade-summary synchronization, and a server-only audit record.
- Firestore denies student access to unreleased assessment results, archived attempt results, and assessment-grade summaries.
- Student UI distinguishes graded but unreleased submissions without needing to read a private result.
- Certified academic records cannot be directly deleted; record history entries are append-only under the current client rules.
- Expanded emulator tests for guardian authorization, result privacy, and record retention.
- Academic home redesigned with distinct instructor/student launchpads, functional quick actions, clearer priorities, accessible navigation, and mobile layouts.
- Existing GitHub Pages, Auth, Firestore, and course data structures are preserved. No data migration or destructive script is included.

## Deployment sequence
**Do not merge/deploy without a passing Validate Theoria run and a backup of deployed Firestore rules.**

1. Verify Firebase CLI targets the existing project `theoria-79433`; ensure Blaze billing is enabled if necessary.
2. From the branch checkout run `npm install` and `npm install --prefix functions`; validate with `npm run check` and emulator tests.
3. Deploy **functions first**: `firebase deploy --project theoria-79433 --only functions`.
4. Deploy **rules second**: `firebase deploy --project theoria-79433 --only firestore:rules`.
5. After successful deployment, merge the branch to publish the updated GitHub Pages frontend.
6. Test with separate student, instructor, unrelated student, authorized grader, guardian, and unapproved guardian accounts.

### Important behavior
- Prior unreleased results remain hidden, even when `complete: true`. Publishing must set `released: true`.
- Making a released result private hides it from student result views and the released grade-summary document.
- Historical results for students are visible only when the corresponding current assessment result is released; older archived history may require a more granular future policy.
- The server-only `systemAcademicAudit` collection intentionally has no matching client Firestore allow rule. Admin SDK writes bypass rules.
- The callable is deployed to `us-central1`.
- Browser-based grading and record certification have not yet moved entirely to Firebase Functions. This is **the foundation phase**, not a claim that every institutional workflow is production-certified.
- The UI is styled without changing the existing Theoria brand palette.

## Follow-up milestones
1. Migrate grade certification/amendment calculations into trusted server-side operations with source-version checks.
2. Atomic institution placement → section enrollment, plus capacity and prerequisite validation.
3. Split large JavaScript modules into dedicated state, data, UI, and domain services.
4. Fully integrate official transcripts, grading scales, program credits, faculty rubric tools, and guardian communication.
5. Add visual and end-to-end browser tests, accessibility checks, and privileged audit tools.
