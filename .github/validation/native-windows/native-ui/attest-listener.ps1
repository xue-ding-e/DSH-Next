# Runs INSIDE the exact owned UI Job as the probe process. No external network changes.
[CmdletBinding()]
param([Parameter(Mandatory)][int]$OwnerPid,[Parameter(Mandatory)][int]$Port,[Parameter(Mandatory)][string]$InstalledRoot,[Parameter(Mandatory)][string]$ReportPath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {throw 'Hosted Windows only'}
if ($OwnerPid -le 0 -or $Port -le 1024 -or $Port -gt 65535) {throw 'Invalid owned PID/port'}
. (Join-Path $PSScriptRoot 'listener-policy.ps1') -OwnerPid $OwnerPid -Port $Port
$deadline=[DateTime]::UtcNow.AddSeconds(30)
do {
  $listeners=@(Get-ProbeListeners $Port)
  if ($listeners.Count -gt 0) {break}
  if ([DateTime]::UtcNow -ge $deadline) {throw 'Installed application did not expose supported local CDP listener'}
  Start-Sleep -Milliseconds 200
} while ($true)
foreach ($listener in $listeners) {
  if ($listener.LocalAddress -notin @('127.0.0.1','::1') -or $listener.OwningProcess -ne $OwnerPid) {throw 'Nonloopback or foreign CDP listener; refusing attachment'}
}
# Exact main PID is stricter than descendants. Unsupported child-owned listeners fail closed.
$attestation=@{ownerPid=$OwnerPid;port=$Port;listeners=@($listeners | ForEach-Object {@{address=$_.LocalAddress;pid=$_.OwningProcess}})}
$attestation | ConvertTo-Json -Depth 4 | Set-Content ($ReportPath+'.listener.json') -Encoding utf8
$pwsh=(Get-Process -Id $PID).Path
& node (Join-Path $PSScriptRoot 'probe-welcome.mjs') $Port $InstalledRoot $ReportPath $OwnerPid $pwsh
if ($LASTEXITCODE -ne 0) {throw 'Installed welcome renderer probe failed'}

# Recheck after probe completion; observations narrow but do not eliminate TOCTOU.
Assert-OwnedProbeListeners @(Get-ProbeListeners $Port) $OwnerPid
