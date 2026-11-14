<# Exercise fresh install, in-place upgrade, repair and uninstall on a disposable Windows runner. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY_ID -ne '1437727533') {
    throw 'This test requires the disposable Windows runner for DSH-Next.'
}
$temporary = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).ProviderPath.TrimEnd('\')
$root = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $root.StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)) {
    throw 'Use a new directory below RUNNER_TEMP.'
}
New-Item -ItemType Directory -Path $root | Out-Null
$Installer = (Resolve-Path -LiteralPath $Installer).ProviderPath
if ([IO.Path]::GetFileName($Installer) -cne "dsh-next-$Version-win-x64-unsigned.exe") {
    throw 'The candidate installer filename does not match the version under test.'
}
$install = Join-Path $root 'application'
$nextHome = Join-Path $root 'next-home'
$officialHome = Join-Path $root 'official-home'
$exe = Join-Path $install 'DSH Next.exe'
$asar = Join-Path $install 'resources\app.asar'
$uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\e74d59b9-768b-51ae-bb11-7f24bfbafa5a'
$protocol = 'HKCU:\Software\Classes\dsh-next'
$commandOwner = 'HKCU:\Software\DSHNext\Command'
$cliDirectory = Join-Path $install 'resources\runtime\cli\bin'
$ownedCommand = '"' + $exe + '" "%1"'
$foreignCommand = '"' + (Join-Path $root 'unrelated.exe') + '" "%1"'
if ((Test-Path -LiteralPath $uninstall) -or (Test-Path -LiteralPath $protocol) -or (Test-Path -LiteralPath $commandOwner)) {
    throw 'The qualification account already owns a DSH Next installation or protocol handler.'
}

function Invoke-OwnedSetup([string]$Path, [string]$Arguments) {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    try {
        if (-not $process.WaitForExit(180000)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw 'The installer or uninstaller timed out.'
        }
        if ($process.ExitCode -ne 0) { throw "Setup exited with $($process.ExitCode)." }
    } finally { $process.Dispose() }
}

function Install-Next([string]$Path) {
    Invoke-OwnedSetup $Path ('/S /currentuser /D=' + $install)
    $registration = Get-ItemProperty -LiteralPath $uninstall
    if ($registration.InstallLocation.TrimEnd('\') -ine $install -or -not (Test-Path -LiteralPath $exe)) {
        throw 'The installed executable and uninstall registration do not agree.'
    }
    if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) { throw 'The installation is missing app.asar.' }
}

function Read-Protocol {
    $key = Get-Item -LiteralPath "$protocol\shell\open\command" -ErrorAction SilentlyContinue
    if ($null -ne $key) { try { return $key.GetValue('') } finally { $key.Close() } }
}

function Start-Installed([string]$ExpectedVersion, [string[]]$Update = @()) {
    $registration = Get-ItemProperty -LiteralPath $uninstall
    if ($registration.DisplayVersion -cne $ExpectedVersion -or $registration.InstallLocation.TrimEnd('\') -ine $install) {
        throw 'The runtime test requires its own registered installation at the expected version.'
    }
    $env:DSH_NEXT_HOME = $nextHome
    $env:DSH_HOME = $officialHome
    $cli = Join-Path $cliDirectory 'dsh-next.cmd'
    $reported = & $cli --version
    if ($LASTEXITCODE -ne 0 -or ($reported -join ' ') -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "The installed dsh-next launcher did not report the expected product version."
    }
    & node (Join-Path $PSScriptRoot '..\..\web\tests\next-installed-startup.mjs') $root $exe $ExpectedVersion @Update
    if ($LASTEXITCODE -ne 0) { throw "Installed Electron startup failed for $ExpectedVersion." }
    if ((Read-Protocol) -cne $ownedCommand) { throw 'The installed app did not register its own protocol.' }
}

function Wait-ForUpdaterRestart {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $registration = Get-ItemProperty -LiteralPath $uninstall
        if ($registration.DisplayVersion -cne $Version -or $registration.InstallLocation.TrimEnd('\') -ine $install) {
            Start-Sleep -Milliseconds 200
            continue
        }
        foreach ($row in Get-CimInstance Win32_Process -Filter "Name='DSH Next.exe'") {
            if ($row.ExecutablePath -ine $exe -or $row.CommandLine -notmatch '(?:^|\s)--updated(?:\s|$)') { continue }
            $process = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
            if ($null -eq $process) { continue }
            try {
                if ($process.HasExited -or $process.Path -ine $exe) { continue }
                Write-Output "Installer restarted $Version (PID $($process.Id))."
                # This disposable account owns the process, which was launched without Playwright.
                $process.Kill($true)
                if (-not $process.WaitForExit(15000)) { throw 'The restarted application did not stop.' }
                return
            } finally { $process.Dispose() }
        }
        Start-Sleep -Milliseconds 200
    } while ($timer.Elapsed.TotalSeconds -lt 180)
    throw 'The updater did not install and relaunch the candidate.'
}

function Invoke-CommandWorker([string]$Operation, [string]$Expected = '') {
    $worker = Join-Path $install 'resources\runtime\cli\command-path.ps1'
    $request = @{ operation = $Operation; directory = $cliDirectory; commandName = 'dsh-next'; expected = $Expected } | ConvertTo-Json -Compress
    $reply = $request | & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File $worker | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $reply.ok) { throw "The installed command worker refused $Operation." }
    return $reply.state
}

function Assert-Data {
    foreach ($path in @($nextHome, $officialHome)) {
        if ([IO.File]::ReadAllText((Join-Path $path 'keep.txt')) -cne $path) { throw "Data changed in $path." }
    }
}

function Remove-Next {
    $registered = Get-ItemProperty -LiteralPath $uninstall
    if ($registered.InstallLocation.TrimEnd('\') -ine $install) { throw 'Refusing to uninstall an unrelated installation.' }
    $copy = Join-Path $root 'uninstall.exe'
    Copy-Item -LiteralPath (Join-Path $install 'Uninstall DSH Next.exe') -Destination $copy -Force
    Invoke-OwnedSetup $copy ('/S /currentuser _?=' + $install)
    if ((Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $uninstall)) { throw 'Installed application or registration remained.' }
    Assert-Data
}

# The last release before the additional-directory event is an upgrade input.
$baselineVersion = '0.2.2-rc.2.20261113.20'
$baselineName = "dsh-next-$baselineVersion-win-x64-unsigned.exe"
$baseline = Join-Path $root $baselineName
Invoke-WebRequest -UseBasicParsing -TimeoutSec 180 -Uri "https://github.com/xue-ding-e/DSH-Next/releases/download/v$baselineVersion/$baselineName" -OutFile $baseline
if ((Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash -ine 'a3b22bc537a6f8627a71c2baf2cf79b398651fbb92f90037cc7687a833af5608') {
    throw 'The baseline installer digest changed.'
}
foreach ($path in @($nextHome, $officialHome)) {
    New-Item -ItemType Directory -Path $path | Out-Null
    [IO.File]::WriteAllText((Join-Path $path 'keep.txt'), $path)
}
Install-Next $baseline
Start-Installed $baselineVersion
Assert-Data
$beforeCommand = Invoke-CommandWorker 'inspect'
$registeredCommand = Invoke-CommandWorker 'install' $beforeCommand.fingerprint
if (-not $registeredCommand.managed -or -not $registeredCommand.available -or $registeredCommand.activeCommand -ine (Join-Path $cliDirectory 'dsh-next.cmd')) {
    throw 'The installed command did not become available through PATH.'
}
Start-Installed $baselineVersion @($Installer, $Version)
Wait-ForUpdaterRestart
Start-Installed $Version
Assert-Data
$installedHash = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash
Install-Next $Installer
if ((Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash -cne $installedHash) { throw 'Same-version repair changed the installed archive.' }
$afterRepair = Invoke-CommandWorker 'inspect'
if (-not $afterRepair.managed -or -not $afterRepair.available) { throw 'Upgrade or repair changed command ownership.' }
$removedCommand = Invoke-CommandWorker 'remove' $afterRepair.fingerprint
if ($removedCommand.managed -or $removedCommand.available) { throw 'The installed command worker left its registration behind.' }
Remove-Next
if (Test-Path -LiteralPath $protocol) { throw 'The owned protocol handler survived uninstall.' }

Install-Next $Installer
$commandKey = New-Item -Path "$protocol\shell\open\command" -Force
try { $commandKey.SetValue('', $foreignCommand) } finally { $commandKey.Close() }
Remove-Next
if ((Read-Protocol) -cne $foreignCommand) { throw 'Uninstall removed the foreign protocol handler.' }
Write-Output "Verified in-app update and automatic restart $baselineVersion -> $Version, repair, Host startup, and both uninstall ownership cases."
