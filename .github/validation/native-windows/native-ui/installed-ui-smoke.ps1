<# REVIEW DRAFT. Only disposable GitHub-hosted Windows runners, never a user PC.
   Original NSIS flag evidence: apps/desktop/tests/windows-uninstall-smoke.ps1.
   This phase checks fixed-new installation, real renderer welcome skip and uninstall;
   it DOES NOT certify right-click UI or automatic updater compatibility. #>
[CmdletBinding()]
param([switch]$Execute)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $Execute) { throw 'Review draft: explicit -Execute on the approved disposable CI runner is required' }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable GitHub-hosted Windows runner required' }
if ($env:GITHUB_REPOSITORY -ne 'xue-ding-e/DSH-Next') { throw 'Wrong repository' }
if ($env:GITHUB_REF -ne 'refs/heads/validation/released-windows-lifecycle') { throw 'Wrong isolated validation branch' }
if (-not $env:RUNNER_TEMP) { throw 'Missing runner temp' }
# Both published source revisions declare this same explicit NSIS GUID. Inspect both
# registry views using .NET, not display-name-only registry-provider enumeration.
$guid = 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a'
function Get-ProductRegistrations {
  $found = [Collections.Generic.List[object]]::new()
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
      try {
        $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($key) { try {
          foreach ($name in $key.GetSubKeyNames()) {
            $entry = $key.OpenSubKey($name)
            try {
              if ($name.Trim('{}') -eq $guid -or $entry.GetValue('DisplayName') -eq 'DSH Next') {
                $found.Add(@{Hive=$hive.ToString();View=$view.ToString();Key=$name;DisplayName=$entry.GetValue('DisplayName');InstallLocation=$entry.GetValue('InstallLocation');DisplayVersion=$entry.GetValue('DisplayVersion')})
              }
            } finally { if ($entry) { $entry.Dispose() } }
          }
        } finally { $key.Dispose() } }
        foreach ($name in @($guid,('{'+$guid+'}'))) {
          $entry=$base.OpenSubKey('Software\'+$name)
          if ($entry) { try { $found.Add(@{Hive=$hive.ToString();View=$view.ToString();Key=('Software\'+$name);DisplayName='InstallRoot';InstallLocation=$entry.GetValue('InstallLocation');DisplayVersion=$null}) } finally { $entry.Dispose() } }
        }
      } finally { $base.Dispose() }
    }
  }
  return $found.ToArray()
}
function Get-NextProtocolViews {
  $found=[Collections.Generic.List[object]]::new()
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
    try { $entry=$base.OpenSubKey('Software\Classes\dsh-next');if ($entry) {try{
      $command=$entry.OpenSubKey('shell\open\command')
      try { $found.Add(@{View=$view.ToString();Command= $(if($command){$command.GetValue('')}else{$null})}) }
      finally { if($command){$command.Dispose()} }
    }finally{$entry.Dispose()}} } finally {$base.Dispose()}
  }
  return $found.ToArray()
}
if (@(Get-ProductRegistrations).Count -ne 0) { throw 'Existing fixed-GUID or named installation: do not replace' }
if (@(Get-NextProtocolViews).Count -ne 0) { throw 'Existing protocol registration: do not replace' }
$base=Split-Path $PSScriptRoot -Parent
Add-Type -Path (Join-Path $base 'OwnedProcessJob.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'OwnedUiJob.cs')
if (Get-Process -Name 'DSH Next' -ErrorAction SilentlyContinue) { throw 'Existing application process' }
$root = Join-Path $env:RUNNER_TEMP ('dsh-release-acceptance-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$install = Join-Path $root 'Installed App'
$profile = Join-Path $root 'Next Synthetic Home'
$upstream = Join-Path $root 'Upstream Synthetic Home'
$outside = Join-Path $root 'External Synthetic Project'
$electronData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'dsh-next-desktop'
$productData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'DSH Next'
foreach ($p in @($electronData,$productData)) { if (Test-Path -LiteralPath $p) { throw 'Existing app data: do not read or modify' } }
foreach ($p in @($profile,$upstream,$outside,$electronData,$productData)) { New-Item -ItemType Directory -Path $p | Out-Null }
# Do not inherit provider credentials, upstream profiles, or npm authentication into the app.
foreach ($item in Get-ChildItem Env:) { if ($item.Name -match '(?i)(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)') { Remove-Item ('Env:'+$item.Name) } }
$env:DSH_NEXT_HOME = $profile
$env:DSH_HOME = $upstream
$env:DSH_TELEMETRY_DISABLED = '1'
$sentinels = @($profile,$upstream,$outside,$electronData,$productData) | ForEach-Object { Join-Path $_ 'acceptance-keep.txt' }
foreach ($p in $sentinels) { [IO.File]::WriteAllText($p,'synthetic acceptance only') }
$expected = @{}
foreach ($p in $sentinels) { $expected[$p] = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }
$assets = @(
  @{Version='0.2.1-rc.3.20261102.8'; Tag='v0.2.1-rc.3.20261102.8'; Sha='9b232ee56cba0b21ab16d7e1c1a007ae31418faf5fa6b44f571e1ee719786947'; Source='275192ff0c4857c137eeaf96f5320d3034c19d35'; Channel='rc'}
)
function Check-Retention {
  foreach ($p in $sentinels) { if (-not (Test-Path -LiteralPath $p) -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne $expected[$p]) { throw "Synthetic data changed: $p" } }
}
$report = [Collections.Generic.List[object]]::new()
foreach ($asset in $assets) {
  $name = 'dsh-next-' + $asset.Version + '-win-x64-unsigned.exe'
  $file = Join-Path $root $name
  Invoke-WebRequest -Uri ('https://github.com/xue-ding-e/DSH-Next/releases/download/'+$asset.Tag+'/'+$name) -OutFile $file -TimeoutSec 300
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.Sha) { throw 'Published installer digest mismatch' }
  # NSIS /D must remain the final argument; this is the exact project smoke-test convention.
  [void][OwnedProcessJob]::Run($file,('/S /D='+$install),$root,600,$false)
  $exe = Join-Path $install 'DSH Next.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Installed executable absent' }
  Check-Retention
  $installed = @(& node (Join-Path $base 'read-installed-identity.mjs') (Join-Path $install 'resources/app.asar') $asset.Version $asset.Source $asset.Channel)
  if ($LASTEXITCODE -ne 0) { throw 'Installed manifest version/channel/source validation failed' }
  if ($installed.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$installed[0])) { throw 'Expected exactly one nonempty installed-identity JSON line' }
  $identity = $installed[0] | ConvertFrom-Json
  if ($null -eq $identity -or $identity -is [array] -or $identity.version -cne $asset.Version -or $identity.channel -cne $asset.Channel -or $identity.sourceSha -cne $asset.Source -or $identity.dirty -cne $false -or $identity.packageName -cne 'dsh-next-desktop' -or $identity.productName -cne 'DSH Next' -or $identity.manifestSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Installed identity JSON incomplete or inconsistent' }
  $entries = @(Get-ProductRegistrations)
  if ($entries.Count -eq 0) { throw 'Missing installed registration' }
  foreach ($entry in $entries) {
    if ($entry.Hive -ne 'CurrentUser' -or -not $entry.InstallLocation -or [IO.Path]::GetFullPath($entry.InstallLocation).TrimEnd('\') -ne $install.TrimEnd('\')) { throw 'Unexpected installation scope or registered location' }
  }
  # OS chooses a random loopback port. Release immediately before owned launch; any
  # race/foreign listener is rejected by attest-listener, never reused or killed.
  $reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $reservation.Start()
  try { $port=([Net.IPEndPoint]$reservation.LocalEndpoint).Port } finally {$reservation.Stop()}
  if($port -le 1024){throw 'Unexpected privileged random port'}
  $probeReport=Join-Path $root 'renderer-report.json'
  $pwsh=(Get-Process -Id $PID).Path
  $probeScript=Join-Path $PSScriptRoot 'attest-listener.ps1'
  $probeArgs='-NoProfile -File "'+$probeScript+'" -OwnerPid {OWNED_APP_PID} -Port '+$port+' -InstalledRoot "'+$install+'" -ReportPath "'+$probeReport+'"'
  try {
    $start=[OwnedUiJob]::Run($exe,('--remote-debugging-address=127.0.0.1 --remote-debugging-port='+$port),$pwsh,$probeArgs,$install,150)
  } finally {
    $closedBy=[DateTime]::UtcNow.AddSeconds(15)
    do {
      $remaining=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq $port})
      if($remaining.Count -eq 0){break}
      if([DateTime]::UtcNow -ge $closedBy){throw 'Debug port remained after owned Job teardown; no cleanup claim'}
      Start-Sleep -Milliseconds 200
    } while($true)
  }
  if(-not(Test-Path -LiteralPath $probeReport)){throw 'Renderer did not emit structured evidence'}
  $renderer=Get-Content -LiteralPath $probeReport -Raw | ConvertFrom-Json
  if($renderer.phase -cne 'C0 renderer/welcome only' -or -not $renderer.renderer.root -or -not $renderer.renderer.newSession){throw 'Incomplete renderer probe'}

  $protocolViews = @(Get-NextProtocolViews)
  if ($protocolViews.Count -eq 0) { throw 'No own protocol registration observed after packaged startup; removal is not yet testable' }
  $expectedCommand = '"' + $exe + '" "%1"'
  foreach ($protocol in $protocolViews) {
    if ($protocol.Command -cne $expectedCommand) { throw 'Protocol command does not belong to this exact installed executable' }
  }
  # Run guarantees the complete Job tree is empty before returning or throws after bounded cleanup.
  $report.Add(@{installedIdentity=$identity;registry=$entries;protocolViews=$protocolViews;installerSha256=$asset.Sha;installedExeSha256=(Get-FileHash $exe -Algorithm SHA256).Hash;processStart=$start;ui=$renderer;debugPortClosed=$true;autoUpdate='not asserted'})
  Check-Retention
}
# Copying and _?= follows the upstream smoke test, avoiding temporary-uninstaller parent ambiguity.
$uninstaller = Join-Path $install 'Uninstall DSH Next.exe'
if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Published installation has no expected uninstaller' }
$copy = Join-Path $root 'uninstall-copy.exe'
Copy-Item -LiteralPath $uninstaller -Destination $copy
[void][OwnedProcessJob]::Run($copy,('/S _?='+$install),$root,120,$false)
$deadline = [DateTime]::UtcNow.AddSeconds(60)
while (Test-Path -LiteralPath $install) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Application directory remained after uninstall' }; Start-Sleep -Milliseconds 200 }
Check-Retention
if (@(Get-ProductRegistrations).Count -ne 0) { throw 'Own install/uninstall registration remained' }
if (@(Get-NextProtocolViews).Count -ne 0) { throw 'Owned Next protocol remained' }
@{cases=$report;uninstall='application removed; five synthetic roots retained';nativeUI='C0 welcome skip and mounted client only; session menus not run';automaticUpgrade='not run';root=$root} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $root 'lifecycle-report.json') -Encoding utf8
# No broad registry, profile, workspace, or recursively followed-link cleanup: dispose the hosted VM.
Write-Output ('Evidence: '+$root)
