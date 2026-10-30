# Only fixed Next keys; record booleans, never registry values or filesystem paths.
param([Parameter(Mandatory)][string]$ExpectedExe, [Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathFullyQualified($ExpectedExe)) { throw 'Expected an absolute owned executable path.' }
$rows = @()
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
        $uninstall = $null; $protocol = $null; $command = $null
        try {
            $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\e74d59b9-768b-51ae-bb11-7f24bfbafa5a')
            $protocol = $base.OpenSubKey('Software\Classes\dsh-next')
            $command = $base.OpenSubKey('Software\Classes\dsh-next\shell\open\command')
            $rows += @{
                hive=[string]$hive; view=[string]$view
                uninstallPresent=($null -ne $uninstall); protocolPresent=($null -ne $protocol)
                protocolUrlMarkerPresent=($null -ne $protocol -and @($protocol.GetValueNames()).Contains('URL Protocol'))
                protocolCommandMatchesOwnedExe=($null -ne $command -and $command.GetValue('') -ceq ('"' + $ExpectedExe + '" "%1"'))
            }
        } finally {
            if ($null -ne $command) { $command.Dispose() }
            if ($null -ne $protocol) { $protocol.Dispose() }
            if ($null -ne $uninstall) { $uninstall.Dispose() }
            $base.Dispose()
        }
    }
}
$rows | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $Output -Encoding utf8
