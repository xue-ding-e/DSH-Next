<# Actual-package silent acceptance only on this run's fresh disposable GitHub-hosted Windows account. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Product, [Parameter(Mandatory)][string]$PackageIndex,
    [Parameter(Mandatory)][string]$NodeExe, [Parameter(Mandatory)][string]$ExpectedNodeSha256)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-owned-process.ps1')
. (Join-Path $PSScriptRoot 'windows-path-guard.ps1')
. (Join-Path $PSScriptRoot 'invoke-protocol-runtime.ps1')
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY_ID -ne '1437727533') { throw 'Fresh GitHub-hosted Windows runner required; never run on a personal computer.' }
if ([Environment]::UserName -ne 'runneradmin' -or [IO.Path]::GetFullPath($env:USERPROFILE) -ne 'C:\Users\runneradmin') { throw 'Unexpected hosted account; no profile data will be touched.' }
$m = Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$temporary = Assert-NextPath -Path $env:RUNNER_TEMP -MustExist
$evidence = Assert-NextPath -Path (Split-Path -Parent ([IO.Path]::GetFullPath($PackageIndex))) -Within $temporary -MustExist
$PackageIndex = Assert-NextPath -Path $PackageIndex -Within $evidence -MustExist
$packages = @(Get-Content -LiteralPath $PackageIndex -Raw | ConvertFrom-Json)
if ($packages.Count -notin @(1,2)) { throw 'Exactly one package or one reviewed V1/V2 pair is required.' }
$officialFile = Assert-NextPath -Path (Join-Path $evidence 'official-identity.json') -Within $evidence -MustExist
$officialIdentity = Get-Content -LiteralPath $officialFile -Raw | ConvertFrom-Json
if ($officialIdentity.source -ne $m.source -or $officialIdentity.appId -ne 'com.deepseek.dsh' -or $officialIdentity.builderVersion -ne '26.17.0' -or $officialIdentity.guid -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $officialIdentity.guid -eq 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a') { throw 'Locked official identity derivation is missing.' }
$root = Join-Path $temporary ('dsh-next-owned-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$root = Assert-NextPath -Path $root -Within $temporary -MustExist
$install = Assert-NextPath -Path (Join-Path $root 'Installed Next') -Within $root
$guid = 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a'
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $guid
$nextProtocol = 'Software\Classes\dsh-next'
$nextOwner = 'Software\DSHNext\Command'
$officialProtocol = 'Software\Classes\dsh'
$officialOwner = 'Software\DeepSeekHarness\Command'
$officialUninstall = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $officialIdentity.guid
$officialInstall = 'Software\' + $officialIdentity.guid
$roaming = [Environment]::GetFolderPath('ApplicationData')
$local = [Environment]::GetFolderPath('LocalApplicationData')
$null = Assert-NextPath -Path $env:USERPROFILE -MustExist
$null = Assert-NextPath -Path $roaming -Within $env:USERPROFILE -MustExist
$null = Assert-NextPath -Path $local -Within $env:USERPROFILE -MustExist
$sentinelRoots = @(
    (Join-Path $env:USERPROFILE '.dsh-next'), (Join-Path $roaming 'DSH Next'),
    (Join-Path $roaming 'dsh-next-desktop'), (Join-Path $local 'dsh-next-desktop-updater'),
    (Join-Path $env:USERPROFILE '.dsh'), (Join-Path $roaming 'DeepSeek Harness'),
    (Join-Path $roaming '@deepseek-ai/dsh-desktop'), (Join-Path $local '@deepseek-aidsh-desktop-updater')
)
function Read-Registry([string]$Path) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Path)
    if ($null -eq $key) { return $null }
    try {
        $values = [ordered]@{}
        foreach ($name in @($key.GetValueNames() | Sort-Object)) {
            $values[$name] = @{ kind=[string]$key.GetValueKind($name); value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        }
        $children = [ordered]@{}
        foreach ($name in @($key.GetSubKeyNames() | Sort-Object)) { $children[$name] = Read-Registry ($Path + '\' + $name) }
        return [ordered]@{ values=$values; children=$children }
    } finally { $key.Dispose() }
}
function Json($Value) { return ConvertTo-Json -InputObject $Value -Depth 20 -Compress }
foreach ($path in @($uninstallKey,('Software\' + $guid),$nextProtocol,$nextOwner,$officialProtocol,$officialOwner,$officialUninstall,$officialInstall)) {
    if ($null -ne (Read-Registry $path)) { throw "Pre-existing identity or command state: $path. Nothing will be overwritten." }
}
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryHive]::CurrentUser)) {
        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
        try {
            foreach ($path in @($uninstallKey,('Software\' + $guid),$officialUninstall,$officialInstall)) {
                $key = $registry.OpenSubKey($path)
                if ($null -ne $key) { $key.Dispose(); throw 'Existing same-GUID user or machine installation; refusing installer.' }
            }
        } finally { $registry.Dispose() }
    }
}
foreach ($path in $sentinelRoots) { $null = Assert-NextPath -Path $path -Within $env:USERPROFILE; if (Test-Path -LiteralPath $path) { throw "Existing profile root: $path. No real profile will be read or changed." } }
$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
try {
    $originalPath = if ($null -eq $environmentKey) { $null } else { $environmentKey.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    $originalKind = if ($null -eq $originalPath) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $environmentKey.GetValueKind('Path') }
} finally { if ($null -ne $environmentKey) { $environmentKey.Dispose() } }
if ($null -ne $originalPath -and $originalPath -isnot [string]) { throw 'Unsupported user PATH value; refusing mutation.' }
$officialBin = Assert-NextPath -Path (Join-Path $root 'Official command sentinel') -Within $root
New-Item -ItemType Directory -Path $officialBin | Out-Null
[IO.File]::WriteAllText((Join-Path $officialBin 'dsh.cmd'), '@echo synthetic official command; never run')
$baselinePath = $officialBin + $(if ($null -ne $originalPath) { ';' + $originalPath } else { '' })
$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try { $environmentKey.SetValue('Path',$baselinePath,$originalKind) } finally { $environmentKey.Dispose() }
$nextBin = Join-Path $install 'resources/runtime/cli/bin'
$pathOwned = $true
$hashes = [ordered]@{}
$lifecycleClock = [Diagnostics.Stopwatch]::StartNew()
$stages = [Collections.Generic.List[object]]::new()
$failure = $null
$installedAttested = $false
$uninstallerHash = $null
$currentPackage = $null
$pathAfterUninstall = $null
$oldHome = $env:DSH_HOME
$oldNextHome = $env:DSH_NEXT_HOME
$oldNodeMode = $env:ELECTRON_RUN_AS_NODE
$env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
$env:DSH_NEXT_HOME = Join-Path $env:USERPROFILE '.dsh-next'
function Invoke-Lifecycle {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory,
        [int]$TimeoutSeconds, [string]$EvidencePrefix, [string]$InputFile = 'NUL', [string]$RawTail = '')
    $null = Assert-NextPath -Path $FilePath -MustExist
    $null = Assert-NextPath -Path $WorkingDirectory -Within $root -AllowRoot -MustExist
    $null = Assert-NextPath -Path $EvidencePrefix -Within $evidence
    if ($InputFile -ne 'NUL') { $null = Assert-NextPath -Path $InputFile -Within $evidence -MustExist }
    $remaining = [int][Math]::Floor(1500 - $lifecycleClock.Elapsed.TotalSeconds)
    if ($remaining -lt 1) { throw 'The reviewed 25-minute native lifecycle budget is exhausted; no new process will start.' }
    return Invoke-NextOwnedProcess -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $WorkingDirectory -TimeoutSeconds ([Math]::Min($TimeoutSeconds,$remaining)) -EvidencePrefix $EvidencePrefix -InputFile $InputFile -RawTail $RawTail
}
function Assert-Preserved([string]$Label) {
    foreach ($path in $hashes.Keys) {
        $null = Assert-NextPath -Path $path -MustExist
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $hashes[$path]) { throw "Synthetic data changed during $Label : $path" }
    }
    foreach ($path in $officialSnapshots.Keys) {
        if ((Json (Read-Registry $path)) -cne $officialSnapshots[$path]) { throw "Official registry sentinel changed during $Label : $path" }
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    try { $value = $key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Dispose() }
    if ($value -cne $baselinePath -and $value -cne ($nextBin + ';' + $baselinePath)) { throw "Unrelated PATH entries changed during $Label" }
    $stages.Add(@{ stage=$Label; preservedFiles=$hashes.Count; officialRegistryUnchanged=$true; pathPreserved=$true })
}
function Attest-Installed([string]$Label, $Package) {
    Assert-NextInstallTree -Path $install -OwnedRoot $root
    $exe = Assert-NextPath -Path (Join-Path $install 'DSH Next.exe') -Within $install -MustExist
    $null = Assert-NextPath -Path $Package.attestation -Within $evidence -MustExist
    $build = Get-Content -LiteralPath $Package.attestation -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.executableSha256) { throw 'Installed executable differs from this run actual package.' }
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
        $null = Invoke-Lifecycle -FilePath $exe -Arguments @((Join-Path $PSScriptRoot 'package-attest.mjs'),$install,$Package.version,$m.source,(Join-Path $evidence ($Label + '.json')),$build.asarSha256) -WorkingDirectory $root -TimeoutSeconds 120 -EvidencePrefix (Join-Path $evidence ($Label + '-attest'))
    } finally { $env:ELECTRON_RUN_AS_NODE = $oldNodeMode }
    $entry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($uninstallKey)
    if ($null -eq $entry) { throw 'The exact Next GUID uninstall registration is missing.' }
    try {
        if ($entry.GetValue('DisplayName') -ne 'DSH Next' -or $entry.GetValue('DisplayVersion') -ne $Package.version -or $entry.GetValue('InstallLocation').TrimEnd('\') -ne $install) { throw 'Next uninstall registration identity/version/location mismatch.' }
    } finally { $entry.Dispose() }
    # The actual application owns protocol registration on first launch.
    $null = Invoke-NextProtocolRuntime -InstalledExe $exe -Attestation (Join-Path $evidence ($Label + '.json')) -Version $Package.version -OwnedRoot $root -Evidence $evidence -Label $Label -ExecutionAuthorized $true -NodeExe $NodeExe -ExpectedNodeSha256 $ExpectedNodeSha256
    $protocol = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($nextProtocol + '\shell\open\command')
    if ($null -eq $protocol) { throw 'Next protocol registration is missing.' }
    try { if ($protocol.GetValue('') -cne ('"' + $exe + '" "%1"')) { throw 'Next protocol does not target this owned installed executable.' } }
    finally { $protocol.Dispose() }
    $script:uninstallerHash = (Get-FileHash -LiteralPath (Join-Path $install 'Uninstall DSH Next.exe') -Algorithm SHA256).Hash
    $script:installedAttested = $true
    $script:currentPackage = $Package
}
function Install-Actual([string]$Label, $Package) {
    $null = Assert-NextPath -Path $Package.installer -Within $evidence -MustExist
    $null = Assert-NextPath -Path $install -Within $root
    foreach ($path in $sentinelRoots) { Assert-NextInstallTree -Path $path -OwnedRoot $env:USERPROFILE }
    if ((Get-FileHash -LiteralPath $Package.installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Package.sha256) { throw 'Installer bytes changed after actual package qualification.' }
    $env:ELECTRON_RUN_AS_NODE = $null
    try {
        $null = Invoke-Lifecycle -FilePath $Package.installer -Arguments @('/S','/currentuser') -RawTail ('/D=' + $install) -WorkingDirectory $root -TimeoutSeconds 300 -EvidencePrefix (Join-Path $evidence $Label)
    } finally { $env:ELECTRON_RUN_AS_NODE = $oldNodeMode }
    Attest-Installed $Label $Package
}
function Uninstall-Actual([string]$Label) {
    if (-not $script:installedAttested) { throw 'Only an attested installation is owned for uninstall.' }
    Assert-NextInstallTree -Path $install -OwnedRoot $root
    foreach ($path in $sentinelRoots) { Assert-NextInstallTree -Path $path -OwnedRoot $env:USERPROFILE }
    $original = Assert-NextPath -Path (Join-Path $install 'Uninstall DSH Next.exe') -Within $install -MustExist
    if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -ne $script:uninstallerHash) { throw 'Owned uninstaller was replaced.' }
    $copy = Assert-NextPath -Path (Join-Path $root ($Label + '.exe')) -Within $root
    if (Test-Path -LiteralPath $copy) { throw 'Uninstaller evidence destination already exists.' }
    Copy-Item -LiteralPath $original -Destination $copy
    # _?= executes the real uninstaller in place, avoiding an unowned detached temporary copy.
    $null = Invoke-Lifecycle -FilePath $copy -Arguments @('/S','/currentuser') -RawTail ('_?=' + $install) -WorkingDirectory $root -TimeoutSeconds 180 -EvidencePrefix (Join-Path $evidence $Label)
    if (Test-Path -LiteralPath $install) { throw 'Owned installation directory remained after uninstall.' }
    $uninstallRemained = $null -ne (Read-Registry $uninstallKey)
    $protocolRemained = $null -ne (Read-Registry $nextProtocol)
    @{ uninstallKeyRemained=$uninstallRemained; protocolKeyRemained=$protocolRemained; installationDirectoryRemained=(Test-Path -LiteralPath $install) } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence ($Label + '-registration.json')) -Encoding utf8
    & (Join-Path $PSScriptRoot 'uninstall-registration-summary.ps1') -ExpectedExe (Join-Path $install 'DSH Next.exe') -Output (Join-Path $evidence ($Label + '-protocol-after-uninstall.json'))
    if ($uninstallRemained -or $protocolRemained) { throw 'Next uninstall/protocol registration remained.' }
    $script:installedAttested = $false
}
function Command-Worker([string]$Label, [string]$Operation, [string]$Expected = '') {
    $inputPath = Assert-NextPath -Path (Join-Path $evidence ($Label + '-input.json')) -Within $evidence
    @{ operation=$Operation; directory=$nextBin; commandName='dsh-next'; expected=$Expected } | ConvertTo-Json -Compress | Set-Content -LiteralPath $inputPath -Encoding utf8
    $worker = Assert-NextPath -Path (Join-Path $install 'resources/runtime/cli/command-path.ps1') -Within $install -MustExist
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $null = Invoke-Lifecycle -FilePath $pwsh -Arguments @('-NoProfile','-NonInteractive','-File',$worker) -WorkingDirectory $root -TimeoutSeconds 30 -EvidencePrefix (Join-Path $evidence $Label) -InputFile $inputPath
    $reply = Get-Content -LiteralPath (Join-Path $evidence ($Label + '.stdout.log')) -Raw | ConvertFrom-Json
    if (-not $reply.ok) { throw 'Actual packaged command worker rejected the operation.' }
    return $reply.state
}
$officialSnapshots = [ordered]@{}
try {
    foreach ($path in @($officialProtocol,$officialOwner,$officialUninstall,$officialInstall)) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
        try { $key.SetValue('SyntheticNextQualification','owned disposable sentinel'); $key.SetValue('Directory',$officialBin) }
        finally { $key.Dispose() }
        $officialSnapshots[$path] = Json (Read-Registry $path)
    }
    foreach ($path in $sentinelRoots) {
        $null = Assert-NextPath -Path $path -Within $env:USERPROFILE
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        foreach ($name in @('sessions/synthetic-session.jsonl','settings/synthetic-settings.json','attachments/synthetic-attachment.bin','synthetic-appdata.bin')) {
            $file = Assert-NextPath -Path (Join-Path $path $name) -Within $path
            New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
            [IO.File]::WriteAllBytes($file,[Text.Encoding]::UTF8.GetBytes('Synthetic fixture only: ' + $name + ' / ' + [Guid]::NewGuid().ToString('N')))
            $hashes[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        }
    }
    $hashes[(Join-Path $officialBin 'dsh.cmd')] = (Get-FileHash (Join-Path $officialBin 'dsh.cmd') -Algorithm SHA256).Hash
    Install-Actual 'fresh-install-v1' $packages[0]
    Assert-Preserved 'fresh-install-v1'
    $state = Command-Worker 'command-inspect' 'inspect'
    $state = Command-Worker 'command-install' 'install' $state.fingerprint
    if (-not $state.managed -or -not $state.available -or $state.activeCommand -ne (Join-Path $nextBin 'dsh-next.cmd')) { throw 'Actual Next command did not become independently available.' }
    Assert-Preserved 'command-install'
    if ($packages.Count -eq 2) {
        Install-Actual 'real-upgrade-v2' $packages[1]
        Assert-Preserved 'real-upgrade-v2'
    }
    $final = $packages[-1]
    Install-Actual 'same-version-repair' $final
    Assert-Preserved 'same-version-repair'
    $cli = Assert-NextPath -Path (Join-Path $nextBin 'dsh-next.cmd') -Within $install -MustExist
    $null = Invoke-Lifecycle -FilePath (Join-Path $PSHOME 'pwsh.exe') -Arguments @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'windows-command-entry.ps1'),'-Mode','cli','-Launcher',$cli) -WorkingDirectory $root -TimeoutSeconds 120 -EvidencePrefix (Join-Path $evidence 'actual-next-cli-version')
    $cliVersion = Get-Content -LiteralPath (Join-Path $evidence 'actual-next-cli-version.stdout.log') -Raw
    $baseVersion = (Get-Content (Join-Path $Product 'apps/desktop/package.json') -Raw | ConvertFrom-Json).version
    if (-not $cliVersion.Contains($baseVersion)) { throw 'Actual bundled CLI did not report its product version.' }
    Assert-Preserved 'actual-next-cli'
    Uninstall-Actual 'silent-uninstall'
    Assert-Preserved 'silent-uninstall'
    $pathAfterUninstall = Read-Registry $nextOwner
    Install-Actual 'reinstall-final' $final
    Assert-Preserved 'reinstall-final'
    $state = Command-Worker 'command-inspect-reinstalled' 'inspect'
    $state = Command-Worker 'command-remove' 'remove' $state.fingerprint
    if ($state.managed) { throw 'Owned Next PATH registration was not removed by the actual command worker.' }
    Assert-Preserved 'command-remove'
    Uninstall-Actual 'final-uninstall'
    Assert-Preserved 'final-uninstall'
} catch { $failure = $_.Exception.Message; throw }
finally {
    try {
        if (-not [NextOwnedProcess]::SafeToStart) { throw 'Owned descendants are not confirmed quiescent; no cleanup process may start.' }
        if ($installedAttested) { Uninstall-Actual 'failure-cleanup-uninstall' }
    } catch { $failure = @($failure,('Owned cleanup: ' + $_.Exception.Message)) -join '; ' }
    try {
        if (-not [NextOwnedProcess]::SafeToStart) { throw 'Owned descendants are not confirmed quiescent; PATH restoration is refused.' }
        if ($pathOwned) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
            try {
                $value = $key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if ($value -cne $baselinePath -and $value -cne ($nextBin + ';' + $baselinePath)) { throw 'PATH changed outside this test; refusing restoration.' }
                if ($null -eq $originalPath) { $key.DeleteValue('Path',$false) } else { $key.SetValue('Path',$originalPath,$originalKind) }
            } finally { $key.Dispose() }
        }
    } catch { $failure = @($failure,('PATH restoration: ' + $_.Exception.Message)) -join '; ' }
    $env:DSH_HOME = $oldHome; $env:DSH_NEXT_HOME = $oldNextHome; $env:ELECTRON_RUN_AS_NODE = $oldNodeMode
    @{ source=$m.source; control=$env:EXPECTED_CONTROL_SHA; repositoryId=$m.repositoryId; packages=$packages;
        stages=$stages.ToArray(); syntheticFileHashes=$hashes; nextCommandOwnerAfterUninstall=$pathAfterUninstall; failure=$failure; qualified=($null -eq $failure);
        upgrade=$(if ($packages.Count -eq 2) { 'V1 to genuinely higher V2 actual NSIS' } else { 'unverified; one package only' });
        gui='unverified; noninteractive hosted runner'; signing='unsigned; no trust qualification';
        data='Byte preservation only; no existing user data or profile migration was tested';
        officialIdentity=$officialIdentity;
        commandCleanup='Actual shipped worker install/remove tested; uninstaller automatic PATH cleanup is not claimed';
        publication='not performed'; fixtureCleanup='Synthetic roots remain only on the disposable hosted VM; no recursive profile cleanup' } |
        ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $evidence 'installer-result.json') -Encoding utf8
    if ($null -ne $failure) { throw $failure }
}
