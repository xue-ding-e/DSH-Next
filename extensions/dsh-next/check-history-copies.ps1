# Verify the two NavHistory copies stay identical in shape.
#
# `lib/client.js` is a classic script the page loads directly, so it CANNOT import
# `lib/history.js`. The class is therefore duplicated: history.js is the copy the
# Node tests exercise, client.js carries the copy that actually runs.
#
# A field added to only one copy is invisible until something reads it, and then
# it fails inside the page where the only symptom is "the plugin did nothing".
# That happened: `stack` read `snapshot.keys.map(...)` against a copy without
# `keys`, and install() threw "Cannot read properties of undefined (reading 'map')".
#
# Exit 0 = both copies expose the same members; 1 = they have drifted.
$ErrorActionPreference = 'Stop'

$root = Join-Path $PSScriptRoot 'dsh-nav-buttons\lib'
$history = Get-Content -LiteralPath (Join-Path $root 'history.js') -Raw -Encoding UTF8
$client = Get-Content -LiteralPath (Join-Path $root 'client.js') -Raw -Encoding UTF8

# Take the text of the class from each file, up to the next top-level construct.
function Get-ClassBody([string]$source, [string]$label) {
    $at = $source.IndexOf('class NavHistory')
    if ($at -lt 0) { throw "no NavHistory class in $label" }
    # The next line that starts at column 0 and is not inside the class ends it.
    $rest = $source.Substring($at)
    $end = $rest.IndexOf("`n}", $rest.IndexOf("`n}") + 1)  # closing brace at column 0
    if ($end -lt 0) { return $rest }
    return $rest.Substring(0, $end)
}

$historyBody = Get-ClassBody $history 'history.js'
$clientBody = Get-ClassBody $client 'client.js'

# Members: methods, getters, #private fields, AND the field names the snapshot
# getter returns. The field names matter most: `keys` was a snapshot field, so
# comparing only method signatures reported "agree" while the page copy lacked it.
function Get-Members([string]$body) {
    $names = @()
    foreach ($line in ($body -split "`n")) {
        if ($line -match '^\s{2}(get\s+)?([A-Za-z#][A-Za-z0-9_#]*)\s*\(') {
            $names += ($matches[1] + $matches[2]).Trim()
        }
        if ($line -match '^\s{2}readonly\s+([A-Za-z#][A-Za-z0-9_]*)') { $names += $matches[1] }
        foreach ($m in [regex]::Matches($line, 'this\.#([A-Za-z][A-Za-z0-9_]*)')) { $names += "#$($m.Groups[1].Value)" }
        # Snapshot properties. The object literal inside `get snapshot()` is
        # indented six spaces, so the match must not assume a fixed depth.
        if ($line -match '^\s+([A-Za-z][A-Za-z0-9_]*):\s') { $names += "snapshot.$($matches[1])" }
    }
    return $names | Sort-Object -Unique
}

$hMembers = Get-Members $historyBody
$cMembers = Get-Members $clientBody

$onlyHistory = $hMembers | Where-Object { $cMembers -notcontains $_ }
$onlyClient = $cMembers | Where-Object { $hMembers -notcontains $_ }

if ($onlyHistory.Count -eq 0 -and $onlyClient.Count -eq 0) {
    Write-Host "NavHistory copies agree: $($hMembers.Count) members in both" -ForegroundColor Green
    exit 0
}
Write-Host ''
Write-Host 'NavHistory COPIES HAVE DRIFTED' -ForegroundColor Red
if ($onlyHistory.Count -gt 0) {
    Write-Host '  only in history.js (the copy the page does NOT run):'
    $onlyHistory | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
}
if ($onlyClient.Count -gt 0) {
    Write-Host '  only in client.js (the copy that DOES run):'
    $onlyClient | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
}
Write-Host ''
Write-Host 'Add the missing member to the other copy, then re-run.'
exit 1
