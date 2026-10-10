# Theoria 6 — Implementation and release notes

## Architecture preserved
- Static GitHub Pages frontend
- Firebase Authentication and Cloud Firestore
- Existing burgundy, parchment, gold, and dark sidebar palette
- Existing independent instructor sections and academic records

## Code added in this release
- `institution-suite.js`: institution command center with active student overview, course-request counts, interventions, academic programs, supervised research projects, teaching plans, family alerts and school forms. Only an institution owner or explicitly delegated administrator sees these controls. It does not bypass classroom certification.
- `role-experience.js`: parent redirect to the separate `parents.html` portal, with student/instructor welcome text adjustments.
- `family.js`: approved guardians can see targeted school alerts alongside the preexisting student-specific institutional academic records and attendance.
- `school-admin.js` and `index.html`: integrated console and script loading.
- `firestore.rules`: institution-scoped create/read constraints for new collections; guardian alerts require an approved per-student access grant.

## Explicit limitations — not production-complete
- Enrollment approvals and registrar placements **do not create real section membership**; section-roster sync is not implemented.
- Automatic class scheduling and timetable optimization are **not implemented**. Existing conflicts are checked client-side and require server-enforced validation for concurrent writes.
- Degree audits, certified GPA and credit equivalency, and transcript synchronization are **not implemented**. Programs currently store administrative requirements; research items store project metadata.
- Bulk assignment editing, rubrics, course rollover and multi-step faculty operations are **not implemented** by the new suite.
- Parent messaging, conference booking and interactive consent-form submissions are **not fully implemented**. This release adds guardian-targeted alerts and institution-authored form definitions. Student-specific guardian reads require data-scoped queries.
- Student-risk indicators are not automated, clinical or predictive. Interventions are manually documented; no AI decisions are made.
- Immutable organization-wide audit logging, automated testing and centrally enforced transactions are **not implemented**. The `auditEvents` collection is defined but not yet automatically written in transactions.
- Identity, institution ownership, guardian authority and school affiliation need operational verification and additional server-side controls before use with sensitive school records.

## Prerequisites for deployment
1. Review the security rules against the existing production rules; back up the current deployed rules.
2. Deploy `firestore.rules` to the intended Firebase project and verify deployment success.
3. Confirm `index.html`, `institution-suite.js`, `role-experience.js`, `family.js`, and `parents.html` all publish via GitHub Pages.
4. Test with separate accounts for student, unrelated student, instructor, principal, registrar, approved parent, unapproved parent, and institution owner.
5. For each new collection test create, read, list, cross-institution access, modification denial, and account sign-out behavior.
6. Verify unapproved parents cannot read student records or alerts; approved parents can read only their linked student's permitted data.
7. Verify a school administrator cannot access another institution's interventions, records or family alerts.
8. Verify all existing assessments, grade certification, and independent instructor enrollment remain functional.
9. Confirm responsive layouts and keyboard navigation on mobile.
10. Do not treat this release as a certified SIS without successful end-to-end testing and privacy review.

## Verification performed
JavaScript parser checks can detect syntax errors but do not validate Firebase authorization semantics, deployment, accessibility, concurrent transactions, or real application workflows. No live Firebase deployment or browser-based end-to-end verification was performed as part of this commit.
