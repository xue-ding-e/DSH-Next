param([Parameter(Mandatory=$true)][string]$Output)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$records = @()
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
    $key=$null; $command=$null
    try {
      $key = $base.OpenSubKey('Software\Classes\dsh-next')
      $command = $base.OpenSubKey('Software\Classes\dsh-next\shell\open\command')
      $records += [ordered]@{ hive=[string]$hive; view=[string]$view; exists=($null -ne $key);
        urlProtocolPresent=($null -ne $key -and @($key.GetValueNames()).Contains('URL Protocol'));
        command=$(if ($null -eq $command) { $null } else { $command.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }) }
    } finally { if ($null -ne $command) {$command.Dispose()}; if ($null -ne $key) {$key.Dispose()}; $base.Dispose() }
  }
}
# Only this one synthetic protocol is read. Never writes or deletes a registry key.
ConvertTo-Json -InputObject @($records) -Depth 5 | Set-Content -LiteralPath $Output -Encoding utf8
