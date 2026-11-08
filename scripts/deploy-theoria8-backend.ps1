#Requires -Version 5.1
<#
.SYNOPSIS
  Theoria 8: validate and deploy the COMPLETE reviewed Firebase Functions and Firestore rules.
.DESCRIPTION
  Default is PREVIEW ONLY. -Deploy changes the intended Firebase project only after
  local syntax + Firestore emulator tests succeed and an explicit production backup confirmation.
  Does not deploy GitHub Pages, Firebase Hosting, or delete any Firebase Function.
  Protects all existing student records and courses.
.EXAMPLE
  .\scripts\deploy-theoria8-backend.ps1
.EXAMPLE
  .\scripts\deploy-theoria8-backend.ps1 -Deploy
.EXAMPLE
  .\scripts\deploy-theoria8-backend.ps1 -Deploy -SkipUnusedExtensionsCheck
#>
[CmdletBinding()]
param([switch] $Deploy, [switch] $SkipUnusedExtensionsCheck)

$ErrorActionPreference = "Stop"
$ProjectId = "theoria-79433"
$ExpectedBranch = "feature/institution-enrollment-overhaul-20261107"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

function Assert-Command([string] $Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required program: $Name"
    }
}
function Invoke-Checked([string] $Executable, [string[]] $CommandArgs) {
    Write-Host ("> " + $Executable + " " + ($CommandArgs -join " ")) -ForegroundColor Cyan
    & $Executable @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE. Deployment stopped."
    }
}

Write-Host "THEORIA 8 | Complete Firebase Functions + Firestore rules" -ForegroundColor Magenta
Write-Host "Project: $ProjectId"
Write-Host "Mode: $(if ($Deploy) { 'VALIDATE + DEPLOY' } else { 'VALIDATE ONLY' })"

foreach ($cmd in @("git.exe","node.exe","npm.cmd","java.exe")) { Assert-Command $cmd }
$nodeVersion = (& node.exe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(22|24)\.') {
    throw "Install Node.js 22 or 24 locally. Found: $nodeVersion"
}
$javaText = (& cmd.exe /c "java.exe -version 2>&1") -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0 -or $javaText -notmatch '(?:openjdk|java)\s+version\s+"?([0-9]+)') {
    throw "Java 21 or newer must be installed to run the Firestore emulator."
}
if ([int]$Matches[1] -lt 21) { throw "Java 21+ required. Found: $($Matches[1])" }

if (-not (Test-Path ".git")) { throw "Open a real Git checkout of Theoria." }
$branch = (& git.exe branch --show-current).Trim()
if ($branch -cne $ExpectedBranch) { throw "Switch to $ExpectedBranch first. Current: $branch" }
$changes = @(& git.exe status --porcelain --untracked-files=no | Where-Object { $_ })
if ($changes.Count -gt 0) { throw "Tracked source has uncommitted changes; commit or stash first." }

foreach ($file in @(
    "firebase.json","firebase.js","firestore.rules","functions/index.js",
    "functions/package.json","functions/academic-policy.js",
    "functions/institution-operations.js","functions/section-lifecycle.js",
    "functions/institution-deletion.js","tests/firestore-rules.test.mjs"
)) {
    if (-not (Test-Path $file)) { throw "Missing deployment source: $file" }
}
$firebaseConfig = Get-Content "firebase.json" -Raw | ConvertFrom-Json
if ($firebaseConfig.firestore.rules -cne "firestore.rules" -or
    $firebaseConfig.functions.source -cne "functions") {
    throw "Firebase configuration differs from the reviewed backend structure."
}
$fnConfig = Get-Content "functions/package.json" -Raw | ConvertFrom-Json
if ($fnConfig.engines.node -cne "22") { throw "Unexpected Functions Node runtime." }
if (-not ((Get-Content "firebase.js" -Raw) -match 'projectId:\s*"theoria-79433"')) {
    throw "The frontend Firebase project ID is not $ProjectId"
}
$functionsIndex = Get-Content "functions/index.js" -Raw
foreach ($fn in @(
    "setAssessmentResultVisibility", "institutionSnapshot", "institutionCommand",
    "sectionLifecycle", "institutionDelete"
)) {
    if (-not $functionsIndex.Contains($fn)) { throw "Missing Function export: $fn" }
}

Invoke-Checked "npm.cmd" @("install","--no-audit","--no-fund")
Invoke-Checked "npm.cmd" @("install","--prefix","functions","--no-audit","--no-fund")
$FirebaseCli = Join-Path $Root "node_modules\.bin\firebase.cmd"
if (-not (Test-Path $FirebaseCli)) { throw "Local Firebase CLI not installed." }
Invoke-Checked "npm.cmd" @("run","check")
Invoke-Checked "npm.cmd" @("--prefix","functions","run","check")
Invoke-Checked $FirebaseCli @("emulators:exec","--only","firestore","--project","demo-theoria","npm.cmd test")

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $Root ("deployment-backups\" + $stamp)
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item "firestore.rules" (Join-Path $backupDir "LOCAL-candidate-firestore.rules")
$hash = (Get-FileHash "firestore.rules" -Algorithm SHA256).Hash
@(
    "Target Firebase project: $ProjectId"
    "Source branch: $branch"
    "Commit: $((& git.exe rev-parse HEAD).Trim())"
    "Candidate Firestore rules SHA256: $hash"
    "NOTE: Local candidate rules are NOT a backup of live deployed rules."
) | Set-Content (Join-Path $backupDir "manifest.txt") -Encoding UTF8

if (-not $Deploy) {
    Write-Host "All validation checks passed. No production changes made." -ForegroundColor Green
    Write-Host "Next: review data exports and deployed rules; run .\scripts\deploy-theoria8-backend.ps1 -Deploy"
    exit 0
}
Write-Host "IMPORTANT: Back up your CURRENTLY DEPLOYED Firestore rules from Firebase Console > Firestore > Rules." -ForegroundColor Yellow
Write-Host "The file under deployment-backups is the NEW LOCAL rules; it is NOT the live backup." -ForegroundColor Yellow
$backupConfirmation = Read-Host "Type BACKED-UP after saving the CURRENT live rules and critical Firestore records"
if ($backupConfirmation -cne "BACKED-UP") { throw "Production backups not confirmed. Stopped." }

Invoke-Checked $FirebaseCli @("projects:list")
$confirmation = Read-Host "Type the exact target Firebase project ID"
if ($confirmation -cne $ProjectId) { throw "Project confirmation did not match $ProjectId" }

if ($SkipUnusedExtensionsCheck) {
    Write-Host "Running the existing narrow Firebase CLI unused-extensions workaround." -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot "skip-unused-extensions-check.ps1") -Root $Root -BackupFolder $backupDir
    if ($LASTEXITCODE -ne 0) { throw "Guarded extensions check workaround failed." }
}

# An explicit function list avoids prompting to delete unrelated deployed Functions.
# The pre-existing assessment release function is included.
$allFunctions = "functions:setAssessmentResultVisibility,functions:institutionSnapshot,functions:institutionCommand,functions:sectionLifecycle,functions:institutionDelete"
Write-Host "Deploying ALL FIVE reviewed callable Firebase Functions..." -ForegroundColor Cyan
Invoke-Checked $FirebaseCli @("deploy","--project",$ProjectId,"--only",$allFunctions)
Write-Host "Deploying complete reviewed Firestore security rules..." -ForegroundColor Cyan
Invoke-Checked $FirebaseCli @("deploy","--project",$ProjectId,"--only","firestore:rules")
Write-Host "Verifying deployed Functions..." -ForegroundColor Cyan
Invoke-Checked $FirebaseCli @("functions:list","--project",$ProjectId)
Write-Host "Backend deployment finished. Verify real-account permissions before merging the frontend." -ForegroundColor Green
