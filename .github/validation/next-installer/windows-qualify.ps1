<# Serial Windows source tests and real unsigned NSIS packaging. No release APIs or signing credentials. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Product, [ValidateSet('install-dependencies','qualify')][string]$Mode = 'qualify')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-owned-process.ps1')
. (Join-Path $PSScriptRoot 'windows-path-guard.ps1')
. (Join-Path $PSScriptRoot 'windows-vctip-policy.ps1')
. (Join-Path $PSScriptRoot 'windows-quarantine.ps1')
$Product = Assert-NextPath -Path ([IO.Path]::GetFullPath($Product)) -MustExist
$m = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($m.diagnosticOnly -ne $false) { throw 'Full qualification requires an explicitly reviewed non-diagnostic manifest.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$temporary = Assert-NextPath -Path $env:RUNNER_TEMP -MustExist
$evidence = Assert-NextPath -Path (Join-Path $temporary 'dsh-next-installer-evidence/windows') -Within $temporary
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
function Check-Source {
    & $node (Join-Path $PSScriptRoot 'qualification.mjs') identity $Product
    if ($LASTEXITCODE -ne 0) { throw 'Reviewed source/control identity or clean-tree gate failed.' }
}
Check-Source
if ($Mode -eq 'install-dependencies') {
    $null = Invoke-NextOwnedProcess -FilePath (Join-Path $PSHOME 'pwsh.exe') -Arguments @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'windows-command-entry.ps1'),'-Mode','dependencies') -WorkingDirectory $Product -TimeoutSeconds 1500 -EvidencePrefix (Join-Path $evidence 'dependencies')
    Check-Source
    exit 0
}
$pnpm = Join-Path $Product 'node_modules/pnpm/bin/pnpm.cjs'
if (-not (Test-Path -LiteralPath $pnpm -PathType Leaf)) { throw 'Pinned workspace pnpm is absent.' }
if ((Get-Content (Join-Path $Product 'node_modules/pnpm/package.json') -Raw | ConvertFrom-Json).version -ne '11.28.5') { throw 'Unexpected pnpm version.' }
if ((Get-Content (Join-Path $Product 'node_modules/typescript/package.json') -Raw | ConvertFrom-Json).version -notmatch '^6\.') { throw 'Project TypeScript 6 is required.' }
$stages = [Collections.Generic.List[object]]::new()
$packages = [Collections.Generic.List[object]]::new()
$failure = $null
function Run-Pnpm([string]$Label, [string[]]$Arguments, [int]$Seconds, [object]$VerifiedTool = $null) {
    $toolArguments = @{}
    if ($null -ne $VerifiedTool) {
        if ($Label -cnotin @('desktop-tests','package-v1','package-v2')) { throw 'Compiler telemetry cleanup is authorized only for the three reviewed compiler commands.' }
        if ($VerifiedTool.Scope -cne $Label) { throw 'Compiler telemetry identity belongs to another command scope.' }
        $toolArguments = @{ VerifiedToolPath=$VerifiedTool.Path; VerifiedToolSha256=$VerifiedTool.Sha256 }
    }
    Check-Source
    $controlSha = $env:GITHUB_SHA
    try {
        # Build metadata must describe the separately checked-out product, never this workflow commit.
        $env:GITHUB_SHA = $m.source
        $result = Invoke-NextOwnedProcess -FilePath $node -Arguments (@($pnpm) + $Arguments) -WorkingDirectory $Product -TimeoutSeconds $Seconds -EvidencePrefix (Join-Path $evidence $Label) @toolArguments
        $stages.Add(@{ label=$Label; arguments=$Arguments; result=$result })
    } finally { $env:GITHUB_SHA = $controlSha }
    Check-Source
}
try {
    $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @((Join-Path $PSScriptRoot 'official-identity.mjs'),$Product,(Join-Path $evidence 'official-identity.json')) -WorkingDirectory $Product -TimeoutSeconds 60 -EvidencePrefix (Join-Path $evidence 'official-identity')
    $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @((Join-Path $PSScriptRoot 'windows-pe-identity.mjs'),'preflight',$Product,(Join-Path $evidence 'pe-builder.json')) -WorkingDirectory $Product -TimeoutSeconds 60 -EvidencePrefix (Join-Path $evidence 'pe-builder')
    $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @('--experimental-transform-types','--test','--test-reporter=tap','.github/validation/next-desktop.test.mjs') -WorkingDirectory $Product -TimeoutSeconds 180 -EvidencePrefix (Join-Path $evidence 'next-source-tests')
    $tap = Get-Content -LiteralPath (Join-Path $evidence 'next-source-tests.stdout.log') -Raw
    if ($tap -notmatch '# tests 35\r?\n' -or $tap -notmatch '# pass 35\r?\n' -or $tap -notmatch '# skipped 0\r?\n') { throw 'All 35 Node source tests must actually pass.' }
    # Fetch the real locked dependency outside Vitest's per-hook clock, under the existing job owner.
    $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @((Join-Path $PSScriptRoot 'electron-dependency.mjs'),$Product,(Join-Path $evidence 'electron-dependency.json')) -WorkingDirectory $Product -TimeoutSeconds 600 -EvidencePrefix (Join-Path $evidence 'electron-dependency')
    Check-Source
    $testReport = Join-Path $evidence 'desktop-tests.json'
    $vctipPolicy = New-NextVerifiedVctipPolicy -WorkingDirectory $Product -EvidenceDirectory $evidence -Scope 'desktop-tests'
    try {
    Run-Pnpm 'desktop-tests' (@('exec','vitest','run') + @($m.desktopTests) + @('--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',('--outputFile=' + $testReport))) 1200 $vctipPolicy
    } finally { $vctipPolicy.FileLock.Dispose() }
    & $node (Join-Path $PSScriptRoot 'qualification.mjs') test-report $Product $testReport
    if ($LASTEXITCODE -ne 0) { throw 'Native Windows test evidence was incomplete.' }
    $smokeReport = Join-Path $evidence 'smoke-profile-tests.json'
    Run-Pnpm 'smoke-profile-tests' (@('exec','vitest','run') + @($m.smokeTests) + @('--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',('--outputFile=' + $smokeReport))) 300
    & $node (Join-Path $PSScriptRoot 'qualification.mjs') smoke-test-report $Product $smokeReport
    if ($LASTEXITCODE -ne 0) { throw 'All three native smoke-profile isolation cases must actually pass.' }
    $versions = @($m.version)
    if ($null -ne $m.upgradeVersion) {
        # The locked project semver implementation compares real versions, not filenames or lexical text.
        & $node -e "const s=require(process.argv[1]); if(!s.valid(process.argv[2])||!s.valid(process.argv[3])||!s.gt(process.argv[3],process.argv[2]))process.exit(1)" (Join-Path $Product 'node_modules/semver') $m.version $m.upgradeVersion
        if ($LASTEXITCODE -ne 0) { throw 'Upgrade requires a genuinely higher reviewed version.' }
        $versions += $m.upgradeVersion
    }
    for ($index = 0; $index -lt $versions.Count; $index++) {
        $version = $versions[$index]
        $label = 'package-v' + ($index + 1)
        Run-Pnpm ($label + '-preflight') @('--dir','apps/desktop','exec','tsx','scripts/package-target.ts','win-x64','--next','--unsigned','--check','--build-version',$version) 180
        # The production entry always passes --publish never to electron-builder; no separate pack path is used.
        $packageToolPolicy = New-NextVerifiedVctipPolicy -WorkingDirectory $Product -EvidenceDirectory $evidence -Scope $label
        try {
        Run-Pnpm $label @('--dir','apps/desktop','run','package:next:win:x64','--build-version',$version) $(if ($index -eq 0) { 9000 } else { 6000 }) $packageToolPolicy
        } finally { $packageToolPolicy.FileLock.Dispose() }
        $output = Join-Path $Product 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts'
        $installer = Join-Path $output ('dsh-next-' + $version + '-win-x64-unsigned.exe')
        $null = Assert-NextPath -Path $installer -Within $Product -MustExist
        if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The actual versioned NSIS installer is missing.' }
        if ((Get-AuthenticodeSignature -LiteralPath $installer).Status -ne 'NotSigned') { throw 'Expected an explicitly unsigned installer.' }
        Save-NextUnqualifiedInstaller -Product $Product -Label $label
        Assert-NextInstallTree -Path $output -OwnedRoot $Product
        $applications = @(Get-ChildItem -LiteralPath $output -Filter 'DSH Next.exe' -Recurse -File)
        if ($applications.Count -ne 1) { throw 'Expected exactly one actual unpacked application.' }
        $app = $applications[0].DirectoryName
        $null = Assert-NextPath -Path $applications[0].FullName -Within $Product -MustExist
        # Only our NSIS and product executable are asserted unsigned. Vendor Electron/Node/DLL signatures
        # are neither removed nor treated as a signature from this project's publisher.
        if ((Get-AuthenticodeSignature -LiteralPath $applications[0].FullName).Status -ne 'NotSigned') { throw 'Expected an explicitly unsigned Next executable.' }
        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($applications[0].FullName)
        $peReport = Join-Path $evidence ($label + '-pe.json')
        @{ ProductName=$info.ProductName; FileVersion=$info.FileVersion; ProductVersion=$info.ProductVersion;
            ProductMajorPart=$info.ProductMajorPart; ProductMinorPart=$info.ProductMinorPart;
            ProductBuildPart=$info.ProductBuildPart; ProductPrivatePart=$info.ProductPrivatePart } |
            ConvertTo-Json | Set-Content -LiteralPath $peReport -Encoding utf8
        $config = Join-Path $output 'builder-effective-config.yaml'
        & $node -e "const fs=require('fs'),yaml=require(process.argv[1]);const c=yaml.load(fs.readFileSync(process.argv[2],'utf8')); const a=require('assert/strict');a.equal(c.appId,'io.github.xue-ding-e.dsh-next');a.equal(c.nsis.guid,'e74d59b9-768b-51ae-bb11-7f24bfbafa5a');a.equal(c.nsis.perMachine,false);a.equal(c.nsis.allowElevation,false);a.equal(c.win.forceCodeSigning,false);a.equal(c.publish,null);a.deepEqual(c.protocols[0].schemes,['dsh-next']);" (Join-Path $Product 'node_modules/js-yaml') $config
        if ($LASTEXITCODE -ne 0) { throw 'Effective production builder configuration is not the reviewed unsigned Next mode.' }
        $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @((Join-Path $PSScriptRoot 'windows-pe-identity.mjs'),'report',$Product,$version,$peReport,$config) -WorkingDirectory $Product -TimeoutSeconds 60 -EvidencePrefix (Join-Path $evidence ($label + '-pe'))
        $attestation = Join-Path $evidence ($label + '.json')
        $oldNodeMode = $env:ELECTRON_RUN_AS_NODE
        try {
            $env:ELECTRON_RUN_AS_NODE = '1'
            $null = Invoke-NextOwnedProcess -FilePath $applications[0].FullName -Arguments @((Join-Path $PSScriptRoot 'package-attest.mjs'),$app,$version,$m.source,$attestation) -WorkingDirectory $Product -TimeoutSeconds 120 -EvidencePrefix (Join-Path $evidence ($label + '-attest'))
        } finally { $env:ELECTRON_RUN_AS_NODE = $oldNodeMode }
        $retained = Join-Path $evidence ('dsh-next-' + $version + '-win-x64-unsigned.exe')
        $null = Assert-NextPath -Path $retained -Within $evidence
        Copy-Item -LiteralPath $installer -Destination $retained
        $hash = (Get-FileHash -LiteralPath $retained -Algorithm SHA256).Hash.ToLowerInvariant()
        $packages.Add(@{ installer=$retained; sha256=$hash; version=$version; attestation=$attestation })
    }
    $packageIndex = Join-Path $evidence 'packages.json'
    $packages.ToArray() | ConvertTo-Json -Depth 10 -AsArray | Set-Content -LiteralPath $packageIndex -Encoding utf8
    & (Join-Path $PSScriptRoot 'windows-installer.ps1') -Product $Product -PackageIndex $packageIndex
    Check-Source
} catch { $failure = $_.Exception.Message; throw }
finally {
    @{ source=$m.source; tree=$m.tree; control=$env:EXPECTED_CONTROL_SHA; repositoryId=$m.repositoryId;
        stages=$stages.ToArray(); packages=$packages.ToArray(); failure=$failure; qualified=($null -eq $failure);
        scope='Actual unsigned x64 NSIS and noninteractive lifecycle; no native GUI, signature trust or publication claim' } |
        ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8
}
