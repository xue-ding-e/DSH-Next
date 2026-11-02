# Formal native menu invocation only; diagnostic observation never focuses or changes windows.
param([Parameter(Mandatory)][int]$OwnerPid,[Parameter(Mandatory)][string]$ReportPath)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows'){throw 'Hosted Windows only'}
if($OwnerPid -le 0){throw 'Invalid owned PID'}
$destination=[IO.Path]::GetFullPath($ReportPath)
$tempRoot=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if(-not $destination.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or -not $destination.EndsWith('.native-menu.json',[StringComparison]::Ordinal)){throw 'Synthetic report destination required'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeMenuObservation {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
$pidCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$OwnerPid)
function Save-OwnedObservation([string]$Phase,$MenuItems){
 # Best-effort evidence cannot change whether the formal check was invoked.
 try {
  [uint32]$foregroundPid=0
  $foreground=[NativeMenuObservation]::GetForegroundWindow()
  [void][NativeMenuObservation]::GetWindowThreadProcessId($foreground,[ref]$foregroundPid)
  $nodes=[Collections.Generic.List[object]]::new()
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$pidCondition)
  function Visit-Owned($Element,[int]$Depth,[int]$ParentIndex){
   if($nodes.Count -ge 128 -or $Depth -ge 4){return}
   $current=$Element.Current
   if($current.ProcessId -ne $OwnerPid){return}
   $index=$nodes.Count
   $name=[string]$current.Name;if($name.Length -gt 120){$name=$name.Substring(0,120)}
   $nodes.Add(@{index=$index;parent=$ParentIndex;depth=$Depth;ownerPid=$current.ProcessId;name=$name;type=$current.ControlType.ProgrammaticName;offscreen=$current.IsOffscreen;enabled=$current.IsEnabled;keyboardFocus=$current.HasKeyboardFocus;windowHandle=$current.NativeWindowHandle})
   $children=$Element.FindAll([Windows.Automation.TreeScope]::Children,$pidCondition)
   foreach($child in $children){Visit-Owned $child ($Depth+1) $index;if($nodes.Count -ge 128){break}}
  }
  foreach($window in $windows){Visit-Owned $window 0 -1;if($nodes.Count -ge 128){break}}
  $menus=@($MenuItems | Select-Object -First 64 | ForEach-Object {
   $item=$_.Current
   if($item.ProcessId -ne $OwnerPid){throw 'Menu evidence ownership changed'}
   $name=[string]$item.Name;if($name.Length -gt 120){$name=$name.Substring(0,120)}
   @{ownerPid=$item.ProcessId;name=$name;type=$item.ControlType.ProgrammaticName;offscreen=$item.IsOffscreen;enabled=$item.IsEnabled;keyboardFocus=$item.HasKeyboardFocus}
  })
  @{phase=$Phase;ownerPid=$OwnerPid;foregroundPid=$foregroundPid;foregroundIsOwned=($foregroundPid -eq $OwnerPid);nodes=$nodes.ToArray();menuItems=$menus;observation='read-only non-atomic; no window focus/visibility changes'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $destination -Encoding utf8
 }catch{Write-Warning ('Owned native observation unavailable: '+$_.Exception.Message.Substring(0,[Math]::Min(300,$_.Exception.Message.Length)))}
}
Save-OwnedObservation 'before-search' @()
$deadline=[DateTime]::UtcNow.AddSeconds(8)
$items=@()
try {
 do {
  $typeCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::MenuItem)
  $condition=[Windows.Automation.AndCondition]::new($pidCondition,$typeCondition)
  $items=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
  $matched=@($items | Where-Object {$_.Current.Name -in @('Check for Updates','Check for Updates…','检查更新','检查更新…')})
  if($matched.Count -eq 1){
   $item=$matched[0]
   if($item.Current.ProcessId -ne $OwnerPid -or -not $item.Current.IsEnabled -or $item.Current.IsOffscreen){throw 'Native update menu ownership/visibility mismatch'}
   Save-OwnedObservation 'matched-check' $items
   # Recheck after diagnostic observation; it does not make ownership atomic.
   if($item.Current.ProcessId -ne $OwnerPid -or -not $item.Current.IsEnabled -or $item.Current.IsOffscreen){throw 'Native update menu changed before invocation'}
   $invoke=$item.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
   $invoke.Invoke()
   @{invoked='Check for Updates';ownerPid=$OwnerPid;downloadInvoked=$false;installInvoked=$false} | ConvertTo-Json -Compress
   exit 0
  }
  if($matched.Count -gt 1){throw 'Ambiguous owned update menu'}
  Start-Sleep -Milliseconds 150
 }while([DateTime]::UtcNow -lt $deadline)
 throw 'No unique owned formal update menu item available; test entry unsupported'
}catch{Save-OwnedObservation 'check-entry-failed' $items;throw}
