# Theoria 7 — Complete PowerShell Firebase Backend Deployment

**Target:** `theoria-79433`  
**Source:** `feature/theoria-7-academic-overhaul`  
**Hosting:** GitHub Pages (not Firebase Hosting)  
**Backend in this release:** Firebase Auth (existing), Firestore rules, and one new callable Firebase Function.

> This deploys the complete backend **currently implemented in the Theoria 7 foundation branch**. It does not magically implement future registrar/grade-certification Functions listed in the upgrade roadmap.

## Prerequisites (Windows PowerShell)

- Node.js **22.x** and npm. Use **`npm.cmd`** on PowerShell, not `npm.ps1`.
- Java **21** recommended for Firestore emulator.
- Git for Windows.
- A Firebase account with appropriate deployment permissions to `theoria-79433`.
- Firebase **Blaze** billing enabled. New 2nd-generation Functions may also require first-deploy Google APIs, service identities, and billing permissions; Firebase CLI will report these.
- A copy of the **currently deployed** Firestore rules from Firebase Console > Build > Firestore Database > Rules. Save this outside your Git working directory. The automation saves a second copy of **local candidate** rules; those are NOT a backup of deployed production rules.

## One-time repository checkout

For a new checkout:

```powershell
git.exe clone https://github.com/Silly-Cheese/theoria.git
Set-Location .\theoria
git.exe fetch origin
git.exe switch --track origin/feature/theoria-7-academic-overhaul
```

For an existing checkout:

```powershell
Set-Location "C:\PATH\TO\YOUR\theoria"
git.exe fetch origin
git.exe switch feature/theoria-7-academic-overhaul
git.exe pull --ff-only origin feature/theoria-7-academic-overhaul
```

If `git switch` says the local branch doesn't exist, use `git.exe switch --track origin/feature/theoria-7-academic-overhaul` once. Avoid force-resetting a branch containing local changes.

## Recommended: script-based deployment

If your PowerShell execution policy blocks `.ps1` files, execute this once in **this PowerShell window only**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

Run checks without production changes first:

```powershell
.\scripts\deploy-theoria-backend.ps1
```

If they pass, and you have saved your **currently deployed** Firestore rules from the Firebase Console, run the full backend deployment:

```powershell
.\scripts\deploy-theoria-backend.ps1 -Deploy
```

The script verifies source branch, Node runtime, source file paths, project configuration, installs dependencies, checks JavaScript and Functions, tests Firestore security rules with the emulator, creates a local candidate-rules snapshot, asks for production rules backup confirmation, shows accessible Firebase projects, and then deploys just the new callable Function followed by Firestore rules. It never deploys Firebase Hosting, never runs database migrations, and never automatically deletes functions.

## Alternative: exact manual commands

In repository root and on the reviewed feature branch:

```powershell
node.exe --version
java.exe -version
npm.cmd install --no-audit --no-fund
npm.cmd install --prefix functions --no-audit --no-fund

npm.cmd run check
npm.cmd --prefix functions run check

.\node_modules\.bin\firebase.cmd emulators:exec --only firestore --project demo-theoria "npm.cmd test"

.\node_modules\.bin\firebase.cmd login
.\node_modules\.bin\firebase.cmd projects:list

# ONLY after saving currently deployed rules separately:
.\node_modules\.bin\firebase.cmd deploy --project theoria-79433 --only functions:setAssessmentResultVisibility
.\node_modules\.bin\firebase.cmd deploy --project theoria-79433 --only firestore:rules

.\node_modules\.bin\firebase.cmd functions:list --project theoria-79433
```

Use `firebase.cmd login --reauth` if login reports an expired session. Since the project has a locally installed Firebase CLI, `.\node_modules\.bin\firebase.cmd` is preferable to whichever global CLI is on PATH. If you prefer the global CLI, run `npm.cmd install -g firebase-tools`, then `firebase.cmd ...`.

**Never run bare `firebase.cmd deploy` from this repository:** `firebase.json` still contains legacy Firebase Hosting configuration, while the site itself is hosted on GitHub Pages. Always specify `--only` targets.

## After backend deployment: manual smoke-test checklist

Use at least three distinct accounts and verify each operation in a normal browser session (not just the emulator):

1. **Instructor:** Open an existing assessment, grade a complete submission, choose Release, confirm it is visible to that student, make it private again, confirm it disappears. Confirm a bad authorization request is refused.
2. **Student:** Before release, the assessment may show “Graded — awaiting release” but must NOT display grades, individual feedback or result documents. After release, result and appropriate feedback should load.
3. **Unrelated student:** Cannot read another student's result or grades.
4. **Institution guardian:** An approved guardian can see only linked student data. An unapproved or revoked guardian cannot.
5. **Academic record:** Existing certified records and amendment history still display. Direct client deletion of history is denied.
6. **GitHub Pages:** Do not merge the draft PR until the backend operations and sign-in work. Once verified, merge the PR to publish the frontend through the normal GitHub Pages pipeline.

## Troubleshooting

| Symptom | Action |
|---|---|
| PowerShell blocks `npm.ps1` or `firebase.ps1` | Use `npm.cmd` and `firebase.cmd` (or local `.\node_modules\.bin\firebase.cmd`). |
| `firebase.cmd` not found | Run `npm.cmd install` in repository root and use the local CLI path. |
| Authentication/authorization failure | Run `.\node_modules\.bin\firebase.cmd login --reauth`; check project access with `projects:list`. |
| Blaze / API enablement / Cloud Build / Artifact Registry / Eventarc errors | Ensure Blaze and required IAM/API permissions. Complete any one-time setup prompts shown by Firebase CLI; do not bypass with `--force`. |
| `java.exe` not found or emulator fails to start | Install Java 21, reopen PowerShell, verify `java.exe -version`. |
| Port 8080 already in use | Stop the other Firestore emulator/process; rerun local tests. |
| Firestore emulator permission test fails | STOP. Review test log and the repository's `firestore.rules` before deploying. |
| Function call gives `functions/not-found` | Verify the callable's exact name and `us-central1` region with `functions:list`. |
| Function succeeds but Firestore rules deploy fails | The function remains deployed, but the rules are still old. Fix the rules error and retry the **rules-only** command; do not merge the frontend yet. |
| Rules work locally but student pages show permission errors | Confirm that live rules match this branch, then test different user roles and query scopes; never loosen rules blindly. |
| Unexpected restriction after rules deployment | Inspect Firestore Rules release history in Firebase Console and restore the previously saved production version if needed. Verify the corresponding frontend behavior before redeploying. |

## Rollback

- The script **does not** provide automatic rollback. A partial deployment is possible.
- For Firestore rules, use the **production rules backup** saved manually and the Firebase Console Rules release history. Restore using the Console or replace `firestore.rules` with the saved production copy and deploy **only** `firestore:rules`.
- For Functions, do not delete deployed functions casually. A prior matching source revision and a targeted function-only deployment are the safer rollback mechanism.
- Firestore data is not modified by deployment itself, but real function invocations can write result releases and audit events. This is **not** a substitute for a Firestore data backup.

See [Theoria 7 Foundation](THEORIA-7-FOUNDATION.md) for scope and future milestones.
