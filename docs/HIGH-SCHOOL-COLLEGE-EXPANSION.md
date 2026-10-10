# Theoria institutional expansion — October 2026

## Implemented in this set of commits
- A separate secondary/postsecondary configuration panel for high schools, mixed institutions, colleges and universities (`campus.js`).
- Configurable credit unit (Carnegie, semester, quarter), calendar type (semester, trimester, quarter) and GPA display scale (4.0 / 5.0 weighted).
- Per-student advisory summaries of certified institution-entered credits.
- Reusable institution rubric definitions with an administrative maximum-point value.
- Course-offering rollover using an existing Theoria catalog course, a new term, and a new enrollment window; no student submissions or grades are copied.
- Family-portal school messages, conference requests and record-correction requests, stored in `familyRequests`.
- Family request inbox for authorized institution administrators, with review states.
- Institution-scoped Firestore rules for settings, rubrics and family requests.
- GitHub Actions workflow that attempts JavaScript syntax validation and Firestore emulator permission tests, including denied institution creation and guardian isolation.

## Important constraints
The expansion **does not fully implement** the user's entire high-school/college SIS request:
- Automatic conversion of approved requests into live section membership, with capacity and prerequisite verification and atomic multi-document writes, still requires implementation.
- Cross-period scheduling optimization and server-validated room/teacher conflicts remain incomplete.
- Degree audits, course equivalencies, repeated-course handling, weighted GPA, graduation certification, and accredited official transcripts are not implemented. The credit panel is explicitly advisory.
- The new rubric library is not yet fully integrated into all instructor grading screens.
- Course rollover copies offering metadata only, not complete section content.
- Family school communications are asynchronous requests, not real-time messaging; conference scheduling is a request, not calendar booking; forms remain school-authored definitions.
- Automated risk analysis, cross-role case reviews and transcript-gradebook integrations remain incomplete.
- School verification, student identity, FERPA procedures, privacy/retention, guardian authority, and institution-specific regulatory compliance require additional operational and technical safeguards.

## Additional final integration updates
- Registrar placement now verifies an active section join code and matching official course. Student-facing offerings display a **Join assigned section** link; students complete the normal join/entrance process themselves. This is a guided enrollment handoff, not automatic atomic roster synchronization.
- A CI workflow and Firestore emulator privacy tests have been added. They still require a successful GitHub Actions run.
- Family requests now support school messages, conference requests and record correction requests, with administrator review.
- High-school and college academic models, per-student advisory credit summaries, reusable rubrics and offering rollover are included.

## Testing and release
No live browser or Firebase deployment was performed in this conversation. A direct validation checkout also could not run because the execution environment could not resolve github.com. JavaScript syntax was checked for the modified modules, but GitHub Actions and Firestore emulator tests are committed **without confirmed passing results**. Review CI output and troubleshoot before deployment. Deploy `firestore.rules` separately to the intended project, then test with distinct unrelated students, instructors, registrars, principals, parents, and institution owners. Test denial as well as permitted access, especially cross-institution and cross-student access.

The existing color palette, independent instructor courses and academic records are intentionally preserved.

## Stabilization update (October 9)
- Registrar now offers approved-placement links into the existing section joining flow, and validates active join codes and matching course references.
- Institutional credit panel calculates advisory credit-weighted GPA for standard A–F grades per stable student UID; it does not handle repeats, transfer credit, nonstandard scales, or official certification.
- Guardian access revocation is available to school administrators and Firestore read authorization requires the underlying invitation to remain approved.
- The CI workflow is present, but passing workflow results and deployed Firebase rules remain unverified. Direct repository checkout failed in this environment due to github.com DNS resolution.

**Not represented as complete:** Automated multi-record roster enrollment, credit equivalency, degree audit, server-managed timetables and concurrency, official transcript certification, full parent calendar/form services, and production security/compliance verification.
