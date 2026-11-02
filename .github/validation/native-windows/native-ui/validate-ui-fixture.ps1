$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {throw 'Hosted Windows fixture only'}
foreach($name in @('listener-policy.ps1','test-listener-policy.ps1','attest-listener.ps1','installed-ui-smoke.ps1','test-owned-ui-job.ps1','validate-ui-fixture.ps1')){
  $tokens=$null;$errors=$null
  [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$errors)
  if($errors.Count -ne 0){throw ('Native UI PowerShell parse failed '+$name+': '+($errors|Out-String))}
}
& (Join-Path $PSScriptRoot 'test-listener-policy.ps1')
# OwnedUiJob controls all of this fixture's descendants; no application is installed here.
& (Join-Path $PSScriptRoot 'test-owned-ui-job.ps1')
Write-Output 'C0 fixture parser/helper passed; installed renderer still requires its separate step.'
