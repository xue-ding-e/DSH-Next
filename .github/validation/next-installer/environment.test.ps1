$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'invoke-protocol-runtime.ps1')
$original=[Environment]::GetEnvironmentVariable('NODE_OPTIONS','Process')
try {
  $env:NODE_OPTIONS='synthetic-forbidden-startup';$env:PROBE_SYNTHETIC_SECRET='synthetic-not-real'
  $safe=@{HOME='synthetic-home';TEMP='synthetic-temp'}
  $value=Invoke-NextCleanEnvironment -Safe $safe -Action {
    if ($env:NODE_OPTIONS -or $env:PROBE_SYNTHETIC_SECRET) { throw 'Ambient secret/startup env leaked' }
    if ($env:HOME -ne 'synthetic-home') { throw 'Whitelist missing' }
    'observed-clean'
  }
  if ($value -ne 'observed-clean' -or $env:NODE_OPTIONS -ne 'synthetic-forbidden-startup') { throw 'Normal restoration failed' }
  $caught=$false
  try { Invoke-NextCleanEnvironment -Safe $safe -Action { throw 'synthetic owned failure' } } catch { $caught=$true }
  if (-not $caught -or $env:NODE_OPTIONS -ne 'synthetic-forbidden-startup' -or $env:PROBE_SYNTHETIC_SECRET -ne 'synthetic-not-real') { throw 'Failure restoration failed' }
  'PASS: actual environment helper sanitizes startup and restores after success/failure; no process launched'
} finally {
  [Environment]::SetEnvironmentVariable('NODE_OPTIONS',$original,'Process')
  [Environment]::SetEnvironmentVariable('PROBE_SYNTHETIC_SECRET',$null,'Process')
}
