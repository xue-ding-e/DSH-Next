# Formal native menu invocation only. Called inside owned probe Job after actual caption-button input.
param([Parameter(Mandatory)][int]$OwnerPid)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows'){throw 'Hosted Windows only'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$deadline=[DateTime]::UtcNow.AddSeconds(8)
do {
  $pidCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$OwnerPid)
  $typeCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::MenuItem)
  $condition=[Windows.Automation.AndCondition]::new($pidCondition,$typeCondition)
  $items=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
  $matched=@($items | Where-Object {$_.Current.Name -in @('Check for Updates','Check for Updates…','检查更新','检查更新…')})
  if($matched.Count -eq 1){
    $item=$matched[0]
    if($item.Current.ProcessId -ne $OwnerPid -or -not $item.Current.IsEnabled -or $item.Current.IsOffscreen){throw 'Native update menu ownership/visibility mismatch'}
    $invoke=$item.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    @{invoked='Check for Updates';ownerPid=$OwnerPid;downloadInvoked=$false;installInvoked=$false} | ConvertTo-Json -Compress
    exit 0
  }
  if($matched.Count -gt 1){throw 'Ambiguous owned update menu'}
  Start-Sleep -Milliseconds 150
}while([DateTime]::UtcNow -lt $deadline)
throw 'No unique owned formal update menu item available; test entry unsupported'
