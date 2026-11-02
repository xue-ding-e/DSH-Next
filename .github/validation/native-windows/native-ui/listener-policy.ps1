param([int]$OwnerPid,[int]$Port)
$ErrorActionPreference='Stop'
function Get-ProbeListeners([int]$ListenPort) {
  # No -LocalPort filter: a legitimate zero-match result is distinct from CIM/API failure.
  return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq $ListenPort})
}
function Assert-OwnedProbeListeners([object[]]$Rows,[int]$ExpectedPid) {
  if ($Rows.Count -eq 0) {throw 'CDP listener absent'}
  foreach($row in $Rows){
    if($row.LocalAddress -notin @('127.0.0.1','::1') -or $row.OwningProcess -ne $ExpectedPid){throw 'Nonloopback or foreign CDP listener'}
  }
}
if($MyInvocation.InvocationName -ne '.'){
  if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows'){throw 'Hosted Windows only'}
  if($OwnerPid -le 0 -or $Port -le 1024 -or $Port -gt 65535){throw 'Invalid owned listener identity'}
  $rows=@(Get-ProbeListeners $Port)
  Assert-OwnedProbeListeners $rows $OwnerPid
  @{ownerPid=$OwnerPid;port=$Port;listeners=@($rows|ForEach-Object{@{address=$_.LocalAddress;pid=$_.OwningProcess}})}|ConvertTo-Json -Depth 4 -Compress
}
