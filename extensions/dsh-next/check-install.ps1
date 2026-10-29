# Verify that the installed profile copy matches this repository copy.
#
# The profile installs these plugins through a `link:` dependency, so a stale
# `node_modules` entry or a moved directory would silently run yesterday's code.
# This check makes that a fact: it compares every file the plugin would load.
#
# Exit 0 = profile matches the repository; 1 = drift; 2 = a path is missing.
$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
$profileModules = 'C:\Users\78140\.dsh\profiles\desktop\node_modules'
$plugins = @('dsh-browser-control', 'dsh-nav-buttons', 'dsh-input-guard')

if (-not (Test-Path -LiteralPath $profileModules)) {
    Write-Host "profile node_modules not found: $profileModules" -ForegroundColor Red
    exit 2
}

$drift = @()
$compared = 0
foreach ($plugin in $plugins) {
    $source = Join-Path $repo $plugin
    $installed = Join-Path $profileModules $plugin
    if (-not (Test-Path -LiteralPath $source)) { $drift += "missing in repository: $plugin"; continue }
    if (-not (Test-Path -LiteralPath $installed)) { $drift += "not installed: $plugin"; continue }

    # A `link:` dependency installs a directory symlink, so the "installed copy"
    # IS the repository copy: hashing both sides can never show drift there. What
    # can still be wrong is *where the link points*, so report that explicitly
    # rather than pretending the comparison proved something.
    $item = Get-Item -LiteralPath $installed -Force
    if ($item.LinkType -eq 'SymbolicLink') {
        $target = @($item.Target)[0]
        $resolved = if ($target -and -not [System.IO.Path]::IsPathRooted($target)) {
            Join-Path $item.Parent.FullName $target
        } else { $target }
        if (-not $resolved -or -not (Test-Path -LiteralPath $resolved)) {
            $drift += "broken link: $plugin -> $target"
            continue
        }
        $expected = (Resolve-Path -LiteralPath $source).Path
        $actual = (Resolve-Path -LiteralPath $resolved).Path
        if ($actual -ne $expected) { $drift += "link points elsewhere: $plugin -> $actual"; continue }
        Write-Host "  $plugin : linked to the repository (identical by construction)"
        continue
    }

    # Only the files that actually ship; tests and docs are irrelevant at runtime.
    foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
        $relative = $file.FullName.Substring($source.Length).TrimStart('\')
        if ($relative -like 'tests\*') { continue }
        $target = Join-Path $installed $relative
        if (-not (Test-Path -LiteralPath $target)) { $drift += "not installed: $plugin\$relative"; continue }
        $compared++
        if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $target).Hash) {
            $drift += "stale install: $plugin\$relative"
        }
    }
}

if ($drift.Count -eq 0) {
    Write-Host "profile resolves to the repository: $compared copied files verified, $($plugins.Count) plugins" -ForegroundColor Green
    exit 0
}
Write-Host "INSTALL DRIFT ($($drift.Count) entries):" -ForegroundColor Yellow
$drift | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host 'Re-install the affected bundle so the profile picks up this code.'
exit 1
