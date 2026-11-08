# Theoria 8 — Institutional management, section deletion and UI overhaul

**Branch:** feature/institution-enrollment-overhaul-20261107  
**Pull request:** https://github.com/Silly-Cheese/theoria/pull/7  
**Firebase project:** theoria-79433  
**Frontend:** GitHub Pages, not Firebase Hosting

## Implemented

- Searchable school/district directory, institution profile, dedicated management navigation, readable KPIs and mobile-responsive admin screens.
- Administrators see the management workspace first; course catalog is collapsible.
- Mobile section pages use a labeled tab selector rather than an overflowing navigation strip.
- Student applications, membership approval, student lists, course registration, bulk registration, withdrawals, transfers and academic-year rollover.
- District school creation, staff role management, two-party district affiliation, policies, academic terms, departments and reports.
- The old browser-based section deletion is replaced with a server-side sectionLifecycle callable. The function inspects related data, allows archive with records preserved, and permits permanent deletion only for completely empty independent sections.
- The institutionDelete callable permits deletion of empty institutions and unreferenced offerings, terms, departments and invitations, with server authorization and dependency checks.
- Existing academic and guardian records remain in place. No data migration or production deployment is performed by simply merging this branch.

## Operational boundaries

**This is a review branch, not evidence of deployment or FERPA compliance.**

- Permanent section deletion is blocked if there are any child documents or associated assessments. Archive instead. School-linked sections must be handled by their registrar.
- Permanent institution deletion is blocked when any related subcollection or child school exists. Archive is the safe non-destructive option.
- Section owners cannot delete section parent documents directly in the client anymore: sectionLifecycle is required.
- The institutional snapshot is limited to 80 documents per collection and 100 schools. Current dashboard counts are not certified district-level totals.
- Complex prerequisites are blocked rather than bypassed. Complete timetable optimization, certified transcript issuing, bulk import of external identities, and identity verification are not included.
- Additional legacy administrative panels are available under Advanced tools during the transition and will need further permission hardening.

## Complete Windows PowerShell deployment

**Prerequisites:** Git for Windows, Node.js 22 or 24, Java JDK 21+, a Firebase login with deploy permissions for the existing project, and backups of CURRENT deployed Firestore rules and critical Firestore records.

From your existing local Theoria checkout:

~~~powershell
git.exe fetch origin
git.exe switch feature/institution-enrollment-overhaul-20261107
git.exe pull --ff-only origin feature/institution-enrollment-overhaul-20261107
~~~

If the branch does not yet exist locally, use this instead of git switch:

~~~powershell
git.exe switch --track origin/feature/institution-enrollment-overhaul-20261107
~~~

The new script validates Node, Java, source branch, dependencies, JavaScript, Firestore emulator authorization tests, target Firebase project and Functions exports. It refuses to deploy without explicit backup and project confirmations.

**Step 1: Validate without touching production:**

~~~powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\deploy-theoria8-backend.ps1
~~~

**Step 2: Back up CURRENT deployed rules** from Firebase Console > Firestore Database > Rules and export critical records. An auto-generated LOCAL candidate rules copy is NOT a backup of live deployed rules.

**Step 3: Deploy all reviewed Functions FIRST, then the complete Firestore rules:**

~~~powershell
.\scripts\deploy-theoria8-backend.ps1 -Deploy
~~~

The five Functions deployed are setAssessmentResultVisibility (existing), institutionSnapshot, institutionCommand, sectionLifecycle, and institutionDelete.

The equivalent full manual steps, only after backups and review, are:

~~~powershell
npm.cmd install --no-audit --no-fund
npm.cmd install --prefix functions --no-audit --no-fund
npm.cmd run check
npm.cmd --prefix functions run check
.\node_modules\.bin\firebase.cmd emulators:exec --only firestore --project demo-theoria "npm.cmd test"
.\node_modules\.bin\firebase.cmd deploy --project theoria-79433 --only "functions:setAssessmentResultVisibility,functions:institutionSnapshot,functions:institutionCommand,functions:sectionLifecycle,functions:institutionDelete"
.\node_modules\.bin\firebase.cmd deploy --project theoria-79433 --only firestore:rules
.\node_modules\.bin\firebase.cmd functions:list --project theoria-79433
~~~

If the Firebase CLI's unused-Extensions problem occurs and the project has zero Extensions, the repository's narrow guarded workaround is available:

~~~powershell
.\scripts\deploy-theoria8-backend.ps1 -Deploy -SkipUnusedExtensionsCheck
~~~

This does not bypass Cloud permissions, billing, Firebase Authentication, or Firestore rules.

**Step 4:** Test the backend with separate owner, registrar, instructor, student and guardian accounts. Only then merge the pull request to publish the frontend through GitHub Pages. Do not deploy Firebase Hosting.

## Must-test scenarios

1. Instructor creates an empty independent section and permanently deletes it through the new callable.
2. A section with students or grades can be archived while preserving historical records.
3. Another instructor cannot delete the owner's section.
4. School enrollment and withdrawal work through Firestore transactions; capacity/schedule rejections are enforced.
5. Empty schools and unreferenced offerings can be deleted; schools/offerings with dependents cannot.
6. District staff cannot access an unapproved school, and unrelated guardians cannot access student records.
7. Desktop/mobile navigation and the advanced legacy tools work without breaking.
