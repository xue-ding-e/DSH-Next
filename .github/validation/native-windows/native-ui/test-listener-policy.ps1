$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'listener-policy.ps1')
$script:fixtureMode='empty'
function Get-NetTCPConnection {
 [CmdletBinding()]param([string]$State)
 if($State -ne 'Listen' -or $ErrorActionPreference -ne 'Stop'){throw 'Query must fail closed'}
 switch($script:fixtureMode){
  'query-error' {throw 'synthetic CIM failure'}
  'empty' {return}
  'other-port' {[pscustomobject]@{LocalPort=9999;LocalAddress='127.0.0.1';OwningProcess=123}}
  'owned' {[pscustomobject]@{LocalPort=9222;LocalAddress='127.0.0.1';OwningProcess=123}}
  'foreign' {[pscustomobject]@{LocalPort=9222;LocalAddress='127.0.0.1';OwningProcess=456}}
  'wildcard' {[pscustomobject]@{LocalPort=9222;LocalAddress='0.0.0.0';OwningProcess=123}}
 }
}
try {
 foreach($mode in @('empty','other-port')){
  $script:fixtureMode=$mode;$rows=@(Get-ProbeListeners 9222)
  if($rows.Count -ne 0){throw 'Expected legitimate zero listeners'}
  $rejected=$false;try{Assert-OwnedProbeListeners $rows 123}catch{$rejected=$true}
  if(-not $rejected){throw 'Absent listener accepted for attachment'}
 }
 $script:fixtureMode='query-error';$failed=$false
 try{[void](Get-ProbeListeners 9222)}catch{if($_.Exception.Message -notmatch 'synthetic CIM failure'){throw};$failed=$true}
 if(-not $failed){throw 'Query failure was mistaken for no listeners'}
 $script:fixtureMode='owned';Assert-OwnedProbeListeners @(Get-ProbeListeners 9222) 123
 foreach($mode in @('foreign','wildcard')){
  $script:fixtureMode=$mode;$rejected=$false
  try{Assert-OwnedProbeListeners @(Get-ProbeListeners 9222) 123}catch{$rejected=$true}
  if(-not $rejected){throw 'Foreign/wildcard listener accepted'}
 }
 Write-Output 'Listener policy synthetic empty/other-port/query-error/owned/foreign/wildcard controls passed.'
} finally {Remove-Item Function:Get-NetTCPConnection}
