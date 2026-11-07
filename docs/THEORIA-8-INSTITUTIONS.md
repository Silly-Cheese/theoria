# Theoria 8 — Institutional management and enrollment upgrade

Branch: feature/institution-enrollment-overhaul-20261107
Firebase project: theoria-79433
Frontend: existing GitHub Pages website

## Implemented in this review branch

- Unified, mobile-friendly district/school command center, with retained access to older advanced tools.
- Admissions applications, staff review of existing membership requests, optional policy-controlled auto-admission, faculty invitations and revocation.
- District school creation, two-party affiliation approval and scoped district privileges.
- Transactional institution-to-classroom registration, class roster and student-dashboard enrollment pointers, capacity validation, basic same-period clash checks, entrance-exam checks and fail-closed prerequisite safeguards.
- Batch class registration (up to 25 students, individual transactions with partial-failure reporting); withdrawals, transfer between schools requiring authorization at both, and annual rollover with history.
- Academic terms and departments, profile editing and archive, school reporting on loaded records, append-only server audit events.
- Direct join protection for sections explicitly associated with a school. Historic data remains intact.

## Operational boundaries and limitations

**Not merged, not deployed, not production verified.** Validate and back up before rollout.

- Each administrative snapshot is limited to 80 documents per collection and 100 schools; dashboards and exports are NOT authoritative totals for large institutions.
- Automated classroom scheduling conflict checks are currently same-period/same-term for new registrations only. Full room, teacher, cross-term and academic prerequisite equivalency checking is not complete.
- Prerequisite structures that cannot be validated are blocked, not silently bypassed.
- Bulk enrollment requires existing authenticated student accounts; external CSV student provisioning and identity verification are not included.
- Historic registrar tools remain available via Additional tools. Existing direct Firestore administrative operations may not use the new audited API until those screens are fully migrated.
- Transferring students does not copy transcripts, historical grades or guardian access into a new school. Original records remain accessible under source-institution permissions.
- Archived institution reactivation, section unlinking, and organization verification workflows require additional privileged operations.
- Verified-email policies, FERPA compliance, guardianship and local student-data retention obligations require real-world verification and school-specific safeguards.
- Instructor authority over linked section rosters is still broader than the school registrar policy; review least-privilege requirements before external institutional use.

## Review and deploy with PowerShell

Save a backup of CURRENTLY DEPLOYED Firestore rules from the Firebase Console, plus data exports, before any deployment.

Run the following from your local repository checkout:

~~~powershell
git.exe fetch origin
git.exe switch --track origin/feature/institution-enrollment-overhaul-20261107
npm.cmd install --no-audit --no-fund
npm.cmd install --prefix functions --no-audit --no-fund
npm.cmd run check
npx.cmd firebase-tools emulators:exec --only firestore --project demo-theoria "npm test"
~~~

After checks, security reviews, backups and live account sandbox tests pass, deploy Functions FIRST, then Firestore rules:

~~~powershell
npx.cmd firebase-tools deploy --project theoria-79433 --only functions:institutionCommand,functions:institutionSnapshot
npx.cmd firebase-tools deploy --project theoria-79433 --only firestore:rules
~~~

Only after backend rollout is verified should the review PR be merged to publish frontend updates through the repository's existing GitHub Pages process. Do not deploy Firebase Hosting solely for this feature.

Test with unrelated student, registrar, teacher, guardian, principal, school owner and district admin accounts. Verify denied cross-institution changes, district affiliation consent, registration seat capacity, no join-code bypass, and no loss of prior grades or academic records.
