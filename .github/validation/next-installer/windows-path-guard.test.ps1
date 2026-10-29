<# Existing and dangling junctions never authorize access to another fixture root. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable hosted Windows only.' }
. (Join-Path $PSScriptRoot 'windows-path-guard.ps1')
$temporary = Assert-NextPath -Path $env:RUNNER_TEMP -MustExist
$root = Join-Path $temporary ('next-path-controls-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$owned = Join-Path $root 'owned'
$other = Join-Path $root 'other-fixture'
New-Item -ItemType Directory -Path $owned,$other | Out-Null
$sentinel = Join-Path $other 'unchanged.bin'
[IO.File]::WriteAllText($sentinel,'synthetic outside sentinel')
$before = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
$link = Join-Path $owned 'junction'
New-Item -ItemType Junction -Path $link -Target $other | Out-Null
foreach ($path in @($link,(Join-Path $link 'unchanged.bin'),(Join-Path $link 'missing/child'))) {
    $rejected = $false
    try { $null = Assert-NextPath -Path $path -Within $owned } catch { $rejected = $true }
    if (-not $rejected) { throw 'Junction ancestor was accepted.' }
}
$rejected = $false
try { Assert-NextInstallTree -Path $owned -OwnedRoot $root } catch { $rejected = $true }
if (-not $rejected) { throw 'Uninstall inventory accepted an owned subtree containing a junction.' }
$emptyTarget = Join-Path $root 'removed-empty-target'
New-Item -ItemType Directory -Path $emptyTarget | Out-Null
$dangling = Join-Path $owned 'dangling'
New-Item -ItemType Junction -Path $dangling -Target $emptyTarget | Out-Null
[IO.Directory]::Delete($emptyTarget)
$rejected = $false
try { $null = Assert-NextPath -Path (Join-Path $dangling 'not-created') -Within $owned } catch { $rejected = $true }
if (-not $rejected) { throw 'Dangling junction ancestor was accepted.' }
if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $before) { throw 'Outside sentinel was changed.' }
Write-Output 'Native canonical path, live/dangling junction and uninstall-tree negative controls passed.'
