#Requires -Version 5.1
<#
.SYNOPSIS
  Safely validates and optionally deploys the Theoria 7 Firebase backend.
.DESCRIPTION
  Run from the feature branch. Without -Deploy, performs all local checks only.
  With -Deploy, additionally requires explicit acknowledgment of a REAL
  backup of CURRENTLY DEPLOYED Firebase Console Firestore rules before changing production.
  Never deploys Firebase Hosting or GitHub Pages, never performs data deletion.
.EXAMPLE
  .\scripts\deploy-theoria-backend.ps1
.EXAMPLE
  .\scripts\deploy-theoria-backend.ps1 -Deploy
#>
[CmdletBinding()]
param([switch] $Deploy)

$ErrorActionPreference = "Stop"
$ProjectId = "theoria-79433"
$ExpectedBranch = "feature/theoria-7-academic-overhaul"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

function Assert-Command([string] $Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing $Name. Install it and reopen PowerShell before retrying."
    }
}

function Invoke-Checked([string] $Executable, [string[]] $CommandArgs) {
    Write-Host ("\n> " + $Executable + " " + ($CommandArgs -join " ")) -ForegroundColor Cyan
    & $Executable @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE. No further deployment commands were run."
    }
}

Write-Host "Theoria 7 | Firebase backend deployment preflight" -ForegroundColor Magenta
Write-Host "Target project: $ProjectId"
Write-Host "Mode: $(if ($Deploy) { 'VALIDATE + DEPLOY' } else { 'VALIDATE ONLY (no production changes)' })"

foreach ($cmd in @("git.exe", "node.exe", "npm.cmd", "java.exe")) {
    Assert-Command $cmd
}

$nodeVersion = (& node.exe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch "^v(22|24)\\.") {
    throw "Use Node.js 22.x or 24.x locally. The deployed Firebase Functions runtime remains Node.js 22. Found: $nodeVersion"
}
Write-Host "Local Node.js version: $nodeVersion (Functions deployment runtime: Node.js 22)" -ForegroundColor DarkCyan
# Java 21+ is required by the current Firebase Firestore emulator.
$javaText = (& cmd.exe /c "java.exe -version 2>&1") -join "`n"
if ($LASTEXITCODE -ne 0) {
    throw "Java could not start. Install Java JDK 21 or later and reopen PowerShell."
}
if (-not ($javaText -match '(?:openjdk|java)\s+version\s+"?([0-9]+)')) {
    throw "Unable to determine Java version. Install Java JDK 21 or later and reopen PowerShell."
}
$javaMajor = [int] $Matches[1]
if ($javaMajor -lt 21) {
    throw "Firebase Firestore emulator requires Java 21 or later. Found Java $javaMajor."
}
Write-Host "Java version: $javaMajor" -ForegroundColor DarkCyan

if (-not (Test-Path ".git")) {
    throw "Run this inside a checked-out Theoria Git repository."
}
$branch = (& git.exe branch --show-current).Trim()
if ($branch -cne $ExpectedBranch) {
    throw "Wrong branch '$branch'. Switch to '$ExpectedBranch' before deploying."
}
$trackedChanges = @(& git.exe status --porcelain --untracked-files=no)
if ($trackedChanges.Count -gt 0 -and -not ($trackedChanges.Count -eq 1 -and -not $trackedChanges[0])) {
    throw "Tracked source files have uncommitted changes. Commit or stash them before deployment."
}
$head = (& git.exe rev-parse --short HEAD).Trim()
Write-Host "Source branch: $branch at $head" -ForegroundColor DarkCyan

foreach ($required in @("firebase.json", "firestore.rules", "functions/index.js", "functions/package.json", "tests/firestore-rules.test.mjs")) {
    if (-not (Test-Path $required)) { throw "Missing required source file: $required" }
}
$config = Get-Content "firebase.json" -Raw | ConvertFrom-Json
if ($config.firestore.rules -cne "firestore.rules" -or $config.functions.source -cne "functions") {
    throw "firebase.json does not match the reviewed Theoria 7 backend configuration."
}
$fnConfig = Get-Content "functions/package.json" -Raw | ConvertFrom-Json
if ($fnConfig.engines.node -cne "22") { throw "Unexpected Node.js runtime in functions/package.json." }
if (-not ((Get-Content "functions/index.js" -Raw) -match "export const setAssessmentResultVisibility")) {
    throw "Expected callable function not found. Do not deploy incomplete backend code."
}
if (-not ((Get-Content "firebase.js" -Raw) -match 'projectId:\s*"theoria-79433"')) {
    throw "The current frontend Firebase project ID differs from '$ProjectId'."
}

Write-Host "\nInstalling root development dependencies..." -ForegroundColor Cyan
Invoke-Checked "npm.cmd" @("install", "--no-audit", "--no-fund")
Write-Host "\nInstalling function runtime dependencies..." -ForegroundColor Cyan
Invoke-Checked "npm.cmd" @("install", "--prefix", "functions", "--no-audit", "--no-fund")

$FirebaseCli = Join-Path $Root "node_modules\.bin\firebase.cmd"
if (-not (Test-Path $FirebaseCli)) { throw "Local Firebase CLI is unavailable: $FirebaseCli" }
Invoke-Checked $FirebaseCli @("--version")

Write-Host "\nChecking JavaScript, Node tests, and function modules..." -ForegroundColor Cyan
Invoke-Checked "npm.cmd" @("run", "check")
Invoke-Checked "npm.cmd" @("--prefix", "functions", "run", "check")
Write-Host "\nRunning Firestore emulator authorization tests..." -ForegroundColor Cyan
Invoke-Checked $FirebaseCli @("emulators:exec", "--only", "firestore", "--project", "demo-theoria", "npm.cmd test")

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFolder = Join-Path $Root ("deployment-backups\" + $stamp)
New-Item -ItemType Directory -Force -Path $backupFolder | Out-Null
Copy-Item "firestore.rules" (Join-Path $backupFolder "LOCAL-rules-to-be-deployed.rules")
$hash = (Get-FileHash "firestore.rules" -Algorithm SHA256).Hash
@(
    "Project: $ProjectId",
    "Source branch: $branch",
    "Git revision: $head",
    "Local rules SHA256: $hash",
    "This snapshot is of LOCAL RULES ONLY. It is NOT a backup of rules currently deployed to Firebase."
) | Set-Content -Encoding UTF8 (Join-Path $backupFolder "deployment-manifest.txt")
Write-Host "\nAll local checks passed." -ForegroundColor Green
Write-Host "Local source snapshot: $backupFolder" -ForegroundColor Green

if (-not $Deploy) {
    Write-Host "No Firebase production changes made. When ready: .\scripts\deploy-theoria-backend.ps1 -Deploy" -ForegroundColor Yellow
    exit 0
}

Write-Host "\nIMPORTANT: Firebase rules deployment REPLACES the current production rules." -ForegroundColor Yellow
Write-Host "Before continuing, copy the CURRENTLY DEPLOYED rules from Firebase Console > Firestore > Rules into a safe file."
Write-Host "Your local source snapshot is not a production rules backup." -ForegroundColor Yellow
$backupConfirmation = Read-Host "Type BACKED-UP after separately saving the deployed production rules"
if ($backupConfirmation -cne "BACKED-UP") { throw "Stopped. Production rules backup not confirmed." }

Write-Host "\nChecking Firebase login and accessible projects..." -ForegroundColor Cyan
Write-Host "If authorization fails, run: firebase.cmd login --reauth  (global CLI) or use the local firebase.cmd under node_modules\.bin"
Invoke-Checked $FirebaseCli @("projects:list")
$projectConfirmation = Read-Host "Type the EXACT destination Firebase project ID ($ProjectId)"
if ($projectConfirmation -cne $ProjectId) { throw "Stopped: project confirmation did not match." }

Write-Host "\n1/3 Deploying ONLY the new callable Firebase Function." -ForegroundColor Cyan
Write-Host "Does not delete or re-deploy other functions." -ForegroundColor DarkCyan
Invoke-Checked $FirebaseCli @("deploy", "--project", $ProjectId, "--only", "functions:setAssessmentResultVisibility")

Write-Host "\n2/3 Deploying Firestore rules." -ForegroundColor Cyan
Invoke-Checked $FirebaseCli @("deploy", "--project", $ProjectId, "--only", "firestore:rules")

Write-Host "\n3/3 Inspecting deployed functions." -ForegroundColor Cyan
Invoke-Checked $FirebaseCli @("functions:list", "--project", $ProjectId)

Write-Host "\nTheoria backend deployment commands finished successfully." -ForegroundColor Green
Write-Host "NEXT: perform the instructor/student/guardian manual verification in docs/THEORIA-7-DEPLOYMENT-POWERSHELL.md."
Write-Host "Do not merge the GitHub Pages frontend until real-account smoke tests pass."
