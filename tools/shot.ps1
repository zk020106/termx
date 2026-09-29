# TermX screenshot tool: render a route from the dev server to a 1440x900 PNG
# so it can be compared against the design frames in termx.vetd/.snapshots.
#
# Usage:
#   & .\tools\shot.ps1 -Route hosts -Out shots/hosts.png
#   & .\tools\shot.ps1 -Route "" -Out shots/workspace.png
#
# Requires: `pnpm dev` running on port 5183.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less
# .ps1 files as ANSI, and non-ASCII bytes break the parser.

param(
	[string]$Route = "",
	[Parameter(Mandatory = $true)][string]$Out,
	[int]$Width = 1440,
	[int]$Height = 900,
	[int]$WaitMs = 6000,
	[string]$Browser = "C:\Program Files\Google\Chrome\Application\chrome.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Browser)) {
	$Browser = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $Browser)) {
	throw "Chrome or Edge not found; cannot take screenshots."
}

try {
	$null = Invoke-WebRequest -Uri "http://localhost:5183/" -TimeoutSec 5 -UseBasicParsing
} catch {
	throw "Dev server is not running on http://localhost:5183 - start it with: pnpm dev"
}

$outPath = [System.IO.Path]::GetFullPath($Out)
$outDir = Split-Path $outPath -Parent
if (-not (Test-Path $outDir)) {
	New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
if (Test-Path $outPath) {
	Remove-Item $outPath -Force
}

$url = "http://localhost:5183/#/$Route"

# Use a fresh profile directory per invocation: $PID stays constant inside one
# PowerShell process, so reusing a directory makes later chrome launches attach to
# the already-running instance and silently skip the screenshot.
$profileDir = Join-Path $env:TEMP ("termx-shot-" + [guid]::NewGuid().ToString("N").Substring(0, 10))

$chromeArgs = @(
	"--headless=new",
	"--disable-gpu",
	"--hide-scrollbars",
	"--no-first-run",
	"--no-default-browser-check",
	"--force-device-scale-factor=1",
	"--window-size=$Width,$Height",
	"--virtual-time-budget=$WaitMs",
	"--user-data-dir=$profileDir",
	"--screenshot=$outPath",
	$url
)

# Chrome writes progress to stderr and may exit non-zero even on success, so run it
# with errors suppressed and verify by checking the produced file instead.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
& $Browser @chromeArgs *> $null
$ErrorActionPreference = $prevEap

# Under --headless=new chrome.exe can return before the browser process has
# finished writing the PNG, so poll for the file instead of checking once.
$deadline = (Get-Date).AddSeconds(45)
while (-not (Test-Path $outPath) -and (Get-Date) -lt $deadline) {
	Start-Sleep -Milliseconds 400
}

if (-not (Test-Path $outPath)) {
	throw "Screenshot failed: $outPath was not created."
}

# Remove the temporary profile so TEMP does not accumulate directories
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
Remove-Item $profileDir -Recurse -Force
$ErrorActionPreference = $prevEap

$size = (Get-Item $outPath).Length
Write-Host ("OK  /{0} -> {1}  ({2} KB)" -f $Route, $outPath, [math]::Round($size / 1KB, 1))
