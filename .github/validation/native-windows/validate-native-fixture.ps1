# Phase A only: parse PowerShell, compile isolated helper, run synthetic owned-process tests.
# No installer download or invocation. Run only after source/event validation.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {throw 'Hosted Windows fixture only'}
foreach ($name in @('released-installer-lifecycle.ps1','test-owned-process-job.ps1','validate-native-fixture.ps1')) {
  $tokens=$null; $errors=$null
  [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$errors)
  if ($errors.Count -ne 0) {throw ("PowerShell parse failed: "+$name+": "+($errors | Out-String))}
}
# Separate child process ensures Add-Type is not duplicated in this PowerShell session.
$pwsh=(Get-Process -Id $PID).Path
$info=[Diagnostics.ProcessStartInfo]::new($pwsh)
$info.ArgumentList.Add('-NoProfile')
$info.ArgumentList.Add('-File')
$info.ArgumentList.Add((Join-Path $PSScriptRoot 'test-owned-process-job.ps1'))
$info.UseShellExecute=$false
$p=[Diagnostics.Process]::Start($info)
try {
  if (-not $p.WaitForExit(90000)) { $p.Kill($true); if (-not $p.WaitForExit(15000)) {throw 'Fixture outer process teardown exceeded deadline'}; throw 'Native fixture exceeded 90 second deadline' }
  if ($p.ExitCode -ne 0) {throw ('Native compile/owned-process fixture failed: '+$p.ExitCode)}
} finally {
  if (-not $p.HasExited) { $p.Kill($true); [void]$p.WaitForExit(15000) }
  $p.Dispose()
}
Write-Output 'Phase A only passed: parser and synthetic native Job fixture. No installed application or UI qualification.'
