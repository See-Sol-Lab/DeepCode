# Verifies the packaged distribution runs without any development tooling.
# Usage (from the repository root):
#   powershell -ExecutionPolicy Bypass -File scripts/verify-desktop-dist.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/verify-desktop-dist.ps1 -ReportPath dist\desktop\acceptance-report.txt
# With -ReportPath the identity facts this script already reads (app version,
# embedded DSH version, source commit) are written as an acceptance report, so
# CI does not re-implement the same three lookups in workflow YAML.
# Runs the packaged exe in smoke mode (DSH_DESKTOP_SMOKE=1) with a PATH that
# contains no Node.js/pnpm/npm directories, reads the real exit code via
# Start-Process -Wait -PassThru (a GUI exe run with `&` reports an empty
# $LASTEXITCODE), then asserts the DSH child exited and port 3080 is released.
# Smoke mode closes the window itself only after the UI loaded, so exit 0 plus
# a released port plus zero leftover processes proves the load succeeded.

param(
    [string] $ReportPath = ''
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path (Get-Location) 'dist\desktop\win-unpacked\DeepSeekGUI.exe'
if (-not (Test-Path $exe)) {
    Write-Error "missing packaged exe: $exe"
    exit 1
}

# Delivery-identity consistency (version contract, DEEPSEEKGUI_VERSIONING.md):
# 1) exe FileVersion = DeepSeekGUI app version (single hand-written source: apps/desktop/package.json).
# 2) resources/dsh/source-commit.txt present and non-empty (packaged builds must be traceable).
# 3) embedded DSH version read from the actual packaged runtime manifest (no second hand-written constant).
# NOTE: comments in this script stay ASCII-only — Windows PowerShell 5.1 decodes BOM-less
# UTF-8 scripts as ANSI and can fold non-ASCII comment lines into following statements.
$desktopManifestPath = Join-Path (Get-Location) 'apps\desktop\package.json'
$appVersion = (Get-Content $desktopManifestPath -Raw | ConvertFrom-Json).version
$fileVersion = (Get-Item $exe).VersionInfo.FileVersion
if ($fileVersion -ne $appVersion) {
    Write-Error "exe FileVersion '$fileVersion' != DeepSeekGUI app version '$appVersion'"
    exit 1
}
Write-Output "exe FileVersion matches DeepSeekGUI app version: $appVersion"

$commitFile = Join-Path (Get-Location) 'dist\desktop\win-unpacked\resources\dsh\source-commit.txt'
if (-not (Test-Path $commitFile)) {
    Write-Error "missing source/commit identifier: $commitFile"
    exit 1
}
$sourceCommit = (Get-Content $commitFile -Raw).Trim()
if ([string]::IsNullOrEmpty($sourceCommit)) {
    Write-Error 'source/commit identifier is empty'
    exit 1
}
Write-Output "embedded DSH source/commit: $sourceCommit"

$dshManifest = Join-Path (Get-Location) 'dist\desktop\win-unpacked\resources\dsh\node_modules\@deepseek-ai\dsh\package.json'
$embeddedDshVersion = (Get-Content $dshManifest -Raw | ConvertFrom-Json).version
if ([string]::IsNullOrEmpty($embeddedDshVersion)) {
    Write-Error "embedded DSH version missing from $dshManifest"
    exit 1
}
Write-Output "embedded DSH version: $embeddedDshVersion"

# P4 release integrity gate: shipping assets, license notices, no session
# logs, and the SHA-256 manifest. All checks are existence/content facts of
# the produced win-unpacked directory; nothing is modified.
$unpacked = Join-Path (Get-Location) 'dist\desktop\win-unpacked'

# Desktop Chrome assets ship inside app.asar (electron-builder files list);
# a missing or empty asar means the chrome/terminal assets did not ship.
$asarPath = Join-Path $unpacked 'resources\app.asar'
if (-not (Test-Path $asarPath) -or (Get-Item $asarPath).Length -eq 0) {
    Write-Error "Desktop Chrome assets missing: app.asar absent or empty at $asarPath"
    exit 1
}
Write-Output 'packaged app.asar present (Desktop Chrome assets shipped)'

# Licensing boundary must ship with every binary (P1 contract). Presence is
# not enough: the file NAME promises a specific license, so each shipped
# notice must also CONTAIN that license. A rename or a repointed source path
# would otherwise ship the wrong text under a trusted name and still pass.
$licenseFiles = @(
    @{ Path = 'licenses\DeepSeekGUI-PolyForm-Perimeter-1.0.1.txt'; Must = @('PolyForm Perimeter License 1.0.1') },
    @{ Path = 'licenses\DEEPSEEKGUI-LICENSE.md'; Must = @('DeepSeekGUI') },
    @{ Path = 'licenses\DeepSeek-Harness-MIT.txt'; Must = @('MIT License', 'Permission is hereby granted') },
    @{ Path = 'licenses\THIRD_PARTY_NOTICES.md'; Must = @('Third-party') }
)
foreach ($license in $licenseFiles) {
    $licensePath = Join-Path $unpacked "resources\$($license.Path)"
    if (-not (Test-Path $licensePath) -or (Get-Item $licensePath).Length -eq 0) {
        Write-Error "license notice missing: $licensePath"
        exit 1
    }
    $licenseText = Get-Content $licensePath -Raw
    foreach ($marker in $license.Must) {
        if ($licenseText -notmatch [regex]::Escape($marker)) {
            Write-Error "license notice content mismatch: $($license.Path) does not contain '$marker'"
            exit 1
        }
    }
}
Write-Output 'license notices present and content-verified (PolyForm Perimeter / MIT / third-party)'

# No session logs may ship in the distribution.
$sessionLogs = Get-ChildItem -Path $unpacked -Recurse -Filter '*.jsonl' -ErrorAction SilentlyContinue
if ($sessionLogs) {
    Write-Error "session logs found in distribution: $($sessionLogs.FullName -join ', ')"
    exit 1
}
Write-Output 'no session logs in distribution'

# SHA-256 manifest: installer and unpacked exe digests must match exactly.
# Path convention (shared with build-desktop-dist.ts): entries are relative
# to dist/desktop with forward slashes; this side joins them back with the
# native separator before resolving.
$manifestPath = Join-Path (Get-Location) 'dist\desktop\SHA256SUMS.txt'
if (-not (Test-Path $manifestPath)) {
    Write-Error "missing SHA-256 manifest: $manifestPath"
    exit 1
}
$manifestLines = Get-Content $manifestPath | Where-Object { $_ -match '^\s*[0-9a-f]{64}\s+(\S+)\s*$' }
if ($manifestLines.Count -eq 0) {
    Write-Error 'SHA-256 manifest has no valid entries'
    exit 1
}
foreach ($line in $manifestLines) {
    if ($line -match '^\s*([0-9a-f]{64})\s+(\S+)\s*$') {
        $expectedHash = $Matches[1]
        $relPath = $Matches[2] -replace '/', '\'
        $artifactPath = Join-Path (Get-Location) "dist\desktop\$relPath"
        if (-not (Test-Path $artifactPath)) {
            Write-Error "SHA-256 manifest names missing artifact: $relPath"
            exit 1
        }
        $actualHash = (Get-FileHash -Path $artifactPath -Algorithm SHA256).Hash.ToLower()
        if ($actualHash -ne $expectedHash) {
            Write-Error "SHA-256 mismatch for $relPath : expected $expectedHash got $actualHash"
            exit 1
        }
        Write-Output "SHA-256 verified: $relPath"
    }
}

# A clean PATH: only Windows system directories. No node, pnpm, npm, git, or
# repository paths. The Electron exe and the DSH service (ELECTRON_RUN_AS_NODE)
# must run with exactly this environment.
$cleanPath = 'C:\Windows\System32;C:\Windows'
$env:PATH = $cleanPath
# Neutralize development environment hooks that could mask a dependency.
$env:NODE_PATH = $null
$env:NODE_OPTIONS = $null
$env:npm_node_execpath = $null
$env:npm_execpath = $null

# Packaged runtime capability gate (P2): Node, pnpm, and the DSH CLI must all
# really execute through the packaged exe (ELECTRON_RUN_AS_NODE) under the
# clean PATH above — no system Node/pnpm, no global PATH entries.
$env:ELECTRON_RUN_AS_NODE = '1'
$nodeVersion = (& $exe --expose-internals -e "console.log(process.version)" 2>&1 | Out-String).Trim()
if ($nodeVersion -notmatch '^v\d+\.\d+\.\d+') {
    Write-Error "packaged Node does not execute: got '$nodeVersion'"
    exit 1
}
Write-Output "packaged Node executes: $nodeVersion"

$pnpmCjs = Join-Path (Get-Location) 'dist\desktop\win-unpacked\resources\dsh\node_modules\pnpm\bin\pnpm.cjs'
$pnpmVersion = (& $exe --expose-internals $pnpmCjs --version 2>&1 | Out-String).Trim()
if ($pnpmVersion -notmatch '^\d+\.\d+\.\d+') {
    Write-Error "packaged pnpm does not execute: got '$pnpmVersion'"
    exit 1
}
Write-Output "packaged pnpm executes: $pnpmVersion"

$dshBin = Join-Path (Get-Location) 'dist\desktop\win-unpacked\resources\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
$dshVersion = (& $exe --expose-internals $dshBin --version 2>&1 | Out-String).Trim()
if ($dshVersion -notmatch '^\d+\.\d+\.\d+') {
    Write-Error "packaged DSH CLI does not execute: got '$dshVersion'"
    exit 1
}
Write-Output "packaged DSH CLI executes: $dshVersion"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$env:DSH_DESKTOP_SMOKE = '1'

# Unique per run, so concurrent or aborted runs never collide; removed in finally.
$stamp = [System.IO.Path]::GetRandomFileName()
$stdoutFile = Join-Path $env:TEMP "deepseekgui-verify-out-$stamp.txt"
$stderrFile = Join-Path $env:TEMP "deepseekgui-verify-err-$stamp.txt"

try {
    Write-Output "launching packaged exe with PATH=$cleanPath"
    $process = Start-Process -FilePath $exe -PassThru -Wait -NoNewWindow `
        -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    $exitCode = $process.ExitCode
    Write-Output "exe exit code: $exitCode"
    if (Test-Path $stdoutFile) {
        Get-Content $stdoutFile | ForEach-Object { Write-Output $_ }
    }
    if (Test-Path $stderrFile) {
        $errors = Get-Content $stderrFile
        if ($errors) {
            Write-Output '--- stderr ---'
            $errors | ForEach-Object { Write-Output $_ }
        }
    }

    if ($exitCode -ne 0) {
        Write-Error "packaged exe exited with code $exitCode"
        exit 1
    }

    Start-Sleep -Seconds 2
    $listener = [System.Net.Sockets.TcpClient]::new()
    try {
        $listener.Connect('127.0.0.1', 3080)
        Write-Error 'port 3080 still in use after window close'
        exit 1
    } catch {
        Write-Output 'port 3080 released after exit'
    } finally {
        $listener.Dispose()
    }

    # The DSH service runs inside the packaged exe process tree; after exit there
    # must be no process still bound to the distribution.
    $leftover = Get-CimInstance Win32_Process -Filter "Name='DeepSeekGUI.exe'" -ErrorAction SilentlyContinue
    if ($leftover) {
        Write-Error 'leftover DeepSeekGUI.exe processes'
        exit 1
    }
    Write-Output 'no leftover processes'
    Write-Output 'PACKAGED SMOKE: PASS'

    if ($ReportPath -ne '') {
        # Every fact below was already read and asserted above: the report is a
        # rendering of this run, never a second lookup that could disagree.
        $installers = Get-ChildItem (Join-Path (Get-Location) 'dist\desktop') -Filter '*.exe' |
            ForEach-Object { "  $($_.Name)" }
        @(
            'DeepSeekGUI Desktop acceptance report',
            "app version: $appVersion",
            "embedded DSH version: $embeddedDshVersion",
            "embedded DSH source/commit: $sourceCommit",
            'parity + packaged acceptance (Case A-F): run separately via test:desktop-parity',
            'distribution verification (clean PATH smoke + version identity + license contents + SHA-256): passed',
            'artifacts:'
        ) + $installers | Set-Content $ReportPath -Encoding UTF8
        Write-Output "acceptance report written to $ReportPath"
    }
} finally {
    Remove-Item $stdoutFile, $stderrFile -ErrorAction SilentlyContinue
}
