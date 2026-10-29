<# Diagnostic-only Windows Desktop test ownership. Never packages, installs or qualifies a release. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Product, [ValidateSet('install-dependencies','diagnose')][string]$Mode = 'diagnose')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-owned-process.ps1')
. (Join-Path $PSScriptRoot 'windows-path-guard.ps1')
. (Join-Path $PSScriptRoot 'windows-vctip-policy.ps1')
$Product = Assert-NextPath -Path ([IO.Path]::GetFullPath($Product)) -MustExist
$m = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'diagnostic-policy.mjs') mode (Join-Path $PSScriptRoot 'manifest.json') $Mode
if ($LASTEXITCODE -ne 0) { throw 'Only the reviewed diagnostic mode may execute this control.' }
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
        if ($Label -cne 'desktop-tests') { throw 'Compiler telemetry cleanup is authorized only for Desktop tests.' }
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
    $vctipPolicy = New-NextVerifiedVctipPolicy -WorkingDirectory $Product -EvidenceDirectory $evidence
    try {
    Run-Pnpm 'desktop-tests' (@('exec','vitest','run') + @($m.desktopTests) + @('--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',('--outputFile=' + $testReport))) 1200 $vctipPolicy
    } finally { $vctipPolicy.FileLock.Dispose() }
    & $node (Join-Path $PSScriptRoot 'qualification.mjs') test-report $Product $testReport
    if ($LASTEXITCODE -ne 0) { throw 'Native Windows test evidence was incomplete.' }
    # Even a clean, non-reproducing diagnostic run stops here; it is not installer qualification.
    Check-Source
} catch { $failure = $_.Exception.Message; throw }
finally {
    @{ source=$m.source; tree=$m.tree; control=$env:EXPECTED_CONTROL_SHA; repositoryId=$m.repositoryId;
        stages=$stages.ToArray(); packages=$packages.ToArray(); failure=$failure; diagnosticOnly=$true; qualified=$false;
        scope='Owned Desktop test process diagnostics only; no packaging, installation, leak-resolution or qualification claim' } |
        ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8
    & $node (Join-Path $PSScriptRoot 'diagnostic-policy.mjs') result (Join-Path $evidence 'result.json')
    if ($LASTEXITCODE -ne 0) { throw 'Diagnostic evidence attempted to claim installer qualification.' }
}
