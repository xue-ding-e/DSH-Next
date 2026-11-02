# Native helper gate: run only on a disposable Windows runner before any installation.
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {throw 'Hosted Windows fixture only'}
Add-Type -Path (Join-Path $PSScriptRoot 'OwnedProcessJob.cs')
$root=Join-Path $env:RUNNER_TEMP ('owned-job-fixture-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$pwsh=(Get-Process -Id $PID).Path
if (-not $pwsh) {throw 'Cannot resolve current PowerShell executable'}
# Parent and child both remain in the owned Job, even when the parent exits first.
$child=Join-Path $root 'child.ps1'
$pidFile=Join-Path $root 'child.pid'
[IO.File]::WriteAllText($child,('$PID | Set-Content -LiteralPath '''+$pidFile.Replace("'","''")+'''; Start-Sleep -Seconds 60'))
$parent=Join-Path $root 'parent.ps1'
[IO.File]::WriteAllText($parent,('Start-Process -FilePath '''+$pwsh.Replace("'","''")+''' -ArgumentList @(''-NoProfile'',''-File'',''"'+$child.Replace("'","''")+'"''); Start-Sleep -Seconds 1; exit 0'))
$clock=[Diagnostics.Stopwatch]::StartNew();$failed=$false
try { [void][OwnedProcessJob]::Run($pwsh,('-NoProfile -File "'+$parent+'"'),$root,5,$false) } catch { $failed=$true }
if (-not $failed -or $clock.Elapsed.TotalSeconds -gt 22) {throw 'Expected bounded failure on live descendant'}
if (-not (Test-Path $pidFile)) {throw 'Child fixture never ran; cannot claim descendant cleanup'}
$childId=[int](Get-Content $pidFile -Raw)
if (Get-Process -Id $childId -ErrorAction SilentlyContinue) {throw 'Owned child remained after exceptional cleanup'}
[void][OwnedProcessJob]::Run($pwsh,'-NoProfile -Command "exit 0"',$root,15,$false)
$nonzero=$false;try { [void][OwnedProcessJob]::Run($pwsh,'-NoProfile -Command "exit 7"',$root,15,$false) } catch {$nonzero=$true}
if (-not $nonzero) {throw 'Nonzero exit was swallowed'}
Write-Output 'Native Job helper: descendant timeout cleanup, successful exit, nonzero exit gates passed.'
