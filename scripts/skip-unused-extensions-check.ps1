#Requires -Version 5.1
<#
.SYNOPSIS
  Opt-in workaround for Firebase CLI issue #9987: unused Extensions API 403.
.DESCRIPTION
  Changes only an installed, locally scoped firebase-tools file under node_modules.
  Skips Extensions API discovery only when function builds contain NO Extensions.
  Never disables Firebase auth, Functions authorization, Security Rules, or deployment access checks.
  Fails closed if actual extensions exist or if the known CLI source shape differs.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Root,
    [Parameter(Mandatory = $true)][string] $BackupFolder
)
$ErrorActionPreference = "Stop"

$firebaseJsonPath = Join-Path $Root "firebase.json"
$fnDir = Join-Path $Root "functions"
$prepareFile = Join-Path $Root "node_modules\firebase-tools\lib\deploy\functions\prepare.js"
if (-not (Test-Path $firebaseJsonPath)) { throw "Missing firebase.json. Extensions workaround aborted." }
if (-not (Test-Path $fnDir)) { throw "Missing functions directory. Extensions workaround aborted." }
$config = Get-Content -LiteralPath $firebaseJsonPath -Raw | ConvertFrom-Json
if ($config.PSObject.Properties.Name -contains "extensions") {
    throw "firebase.json configures extensions. Refusing to skip Firebase Extensions checks."
}
if (Test-Path (Join-Path $Root "extensions")) {
    throw "An extensions directory exists. Refusing to skip Firebase Extensions checks."
}
$extensionImports = @(Get-ChildItem -Path $fnDir -Filter "*.js" -File -Recurse |
    Where-Object { $_.FullName -notmatch "[\\/]node_modules[\\/]" } |
    Select-String -Pattern "firebase-functions/extensions" -ErrorAction Stop)
if ($extensionImports.Count -gt 0) {
    throw "Firebase Functions code references Extensions. Refusing to skip API checks."
}
if (-not (Test-Path -LiteralPath $prepareFile)) {
    throw "Known local firebase-tools prepare.js file not found. Upgrade the Firebase CLI or use the non-Extensions-free deployment path."
}

$source = [System.IO.File]::ReadAllText($prepareFile)
$buggy = 'Object.values(wantBuilds).some((b) => b.extensions)'
$fixed = 'Object.values(wantBuilds).some((b) => b.extensions && Object.keys(b.extensions).length > 0)'
if ($source.Contains($fixed)) {
    Write-Host "Firebase CLI already checks for nonempty extensions; no workaround needed." -ForegroundColor Green
    return
}
$matchCount = ([regex]::Matches($source, [regex]::Escape($buggy))).Count
if ($matchCount -ne 1) {
    throw "Installed Firebase CLI does not match the known safe single-line workaround (found $matchCount matches). No code changed."
}

if (-not (Test-Path $BackupFolder)) { New-Item -ItemType Directory -Force $BackupFolder | Out-Null }
$backupPath = Join-Path $BackupFolder "firebase-tools-functions-prepare.original.js"
Copy-Item -LiteralPath $prepareFile -Destination $backupPath -ErrorAction Stop
$updated = $source.Replace($buggy, $fixed)
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($prepareFile, $updated, $utf8)
& node.exe --check $prepareFile
if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath $backupPath -Destination $prepareFile -Force
    throw "Patched Firebase CLI failed syntax validation. Original CLI file restored."
}
Write-Host "Skipping unused Extensions discovery for this local Firebase CLI only." -ForegroundColor Green
Write-Host "Original CLI source saved: $backupPath"
Write-Host "This workaround is temporary, local to node_modules, and can be overwritten by npm install." -ForegroundColor Yellow
