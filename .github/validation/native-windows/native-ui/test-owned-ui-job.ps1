$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {throw 'Hosted Windows fixture only'}
Add-Type -Path (Join-Path $PSScriptRoot 'OwnedUiJob.cs')
$root=Join-Path $env:RUNNER_TEMP ('owned-ui-fixture-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$pwsh=(Get-Process -Id $PID).Path
$app=Join-Path $root 'app.ps1'
$appPid=Join-Path $root 'app.pid'
[IO.File]::WriteAllText($app,('$PID | Set-Content -LiteralPath '''+$appPid.Replace("'","''")+'''; Start-Sleep -Seconds 90'))
foreach ($mode in @('success','nonzero','timeout')) {
  Remove-Item $appPid -ErrorAction SilentlyContinue
  $probe=Join-Path $root 'probe.ps1'
  $child=Join-Path $root 'child.ps1'
  $childPid=Join-Path $root 'child.pid'
  Remove-Item $childPid -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($child,('$PID | Set-Content -LiteralPath '''+$childPid.Replace("'","''")+'''; Start-Sleep -Seconds 90'))
  $body='param([int]$OwnerPid); if($OwnerPid -le 0){exit 8}; Start-Process -FilePath '''+$pwsh.Replace("'","''")+''' -ArgumentList @(''-NoProfile'',''-File'',''"'+$child.Replace("'","''")+'"'' ); Start-Sleep -Seconds 2; '
  $body += $(switch($mode){'success' {'exit 0'} 'nonzero' {'exit 7'} 'timeout' {'Start-Sleep -Seconds 90'}})
  [IO.File]::WriteAllText($probe,$body)
  $failed=$false;$clock=[Diagnostics.Stopwatch]::StartNew()
  try { [void][OwnedUiJob]::Run($pwsh,('-NoProfile -File "'+$app+'"'),$pwsh,('-NoProfile -File "'+$probe+'" -OwnerPid {OWNED_APP_PID}'),$root,8) } catch {$failed=$true}
  if (($mode -eq 'success' -and $failed) -or ($mode -ne 'success' -and -not $failed)) {throw ('Unexpected probe result '+$mode)}
  if ($clock.Elapsed.TotalSeconds -gt 25) {throw 'Unbounded helper completion'}
  foreach($pidFile in @($appPid,$childPid)){
    if(-not(Test-Path $pidFile)){throw 'Fixture did not execute; no cleanup proof'}
    $ownedId=[int](Get-Content $pidFile -Raw)
    if(Get-Process -Id $ownedId -ErrorAction SilentlyContinue){throw 'Owned app/probe descendant survived'}
  }
}
Write-Output 'Owned UI Job synthetic success/nonzero/timeout cleanup passed; no installed app run.'
