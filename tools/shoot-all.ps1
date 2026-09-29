# Screenshot all 16 TermX screens at 1440x900 for review / design comparison.
#
# Usage:
#   & .\tools\shoot-all.ps1                  # -> shots/*.png
#   & .\tools\shoot-all.ps1 -OutDir shots/v2
#
# Requires: `pnpm dev` running on port 5183.
# Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI).

param(
	[string]$OutDir = "shots"
)

$ErrorActionPreference = "Stop"

$routes = [ordered]@{
	"workspace"      = ""
	"hosts"          = "hosts"
	"host-edit"      = "hosts/new"
	"connect"        = "connect"
	"sftp"           = "sftp"
	"editor"         = "editor"
	"transfers"      = "transfers"
	"forward"        = "forward"
	"snippets"       = "snippets"
	"keys"           = "keys"
	"monitor"        = "monitor"
	"settings"       = "settings"
	"welcome"        = "welcome"
	"lock"           = "lock"
	"palette"        = "palette"
	"updater"        = "updater"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$shotScript = Join-Path $scriptDir "shot.ps1"

# NOTE: iterate with GetEnumerator(), not $routes.Keys. The table has an entry
# literally named "keys", and PowerShell resolves a dictionary member access to a
# matching KEY first, so $routes.Keys would return that entry's value instead of
# the key collection.
$results = @()
foreach ($entry in $routes.GetEnumerator()) {
	$name = $entry.Key
	$route = $entry.Value
	$out = Join-Path $OutDir "$name.png"
	# Tolerate per-screen failures so one bad route cannot abort the batch
	try {
		& $shotScript -Route $route -Out $out | Out-Null
	} catch {
		Write-Host ("FAIL {0}: {1}" -f $name, $_.Exception.Message)
	}
	if (Test-Path $out) {
		$results += [pscustomobject]@{ Screen = $name; Route = $route; KB = [math]::Round((Get-Item $out).Length / 1KB, 1) }
	} else {
		$results += [pscustomobject]@{ Screen = $name; Route = $route; KB = "FAILED" }
	}
}

$results | Format-Table -AutoSize
$failed = ($results | Where-Object { $_.KB -eq "FAILED" }).Count
Write-Host ("{0}/{1} screenshots OK" -f ($results.Count - $failed), $results.Count)
