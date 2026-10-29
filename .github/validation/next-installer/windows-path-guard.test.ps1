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
# Observe the old raw Win32 call shape without asserting it must fail. A host may
# already opt in to long paths; neither a pass nor a failure proves Ca's lost path.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NextRawPathObservation {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributes(string path);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public sealed class Result { public int length, attributesError, openError; public bool attributesSucceeded, opened; }
    public static Result Inspect(string path) {
        uint attributes=GetFileAttributes(path); int error=attributes==0xffffffff ? Marshal.GetLastWin32Error() : 0;
        IntPtr handle=CreateFile(path,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        bool opened=handle!=new IntPtr(-1); int openError=opened ? 0 : Marshal.GetLastWin32Error();
        if (opened) CloseHandle(handle);
        return new Result { length=path.Length,attributesError=error,openError=openError,attributesSucceeded=attributes!=0xffffffff,opened=opened };
    }
}
'@
function Require-Missing([string]$MissingPath) {
    $observed=$null
    try { $null=Assert-NextPath -Path $MissingPath -Within $owned -MustExist } catch {
        $errorObject=$_.Exception
        while ($null -ne $errorObject.InnerException) { $errorObject=$errorObject.InnerException }
        if ($errorObject -isnot [ComponentModel.Win32Exception] -or $errorObject.NativeErrorCode -notin @(2,3)) { throw }
        if (-not $errorObject.Message.Contains($MissingPath) -or -not $errorObject.Message.Contains('utf16Length='+$MissingPath.Length) -or -not $errorObject.Message.Contains('win32Error='+$errorObject.NativeErrorCode)) { throw 'Missing-path native context was lost.' }
        $observed=@{ pathLength=$MissingPath.Length; win32Error=$errorObject.NativeErrorCode; rejected=$true }
    }
    if ($null -eq $observed) { throw 'A genuinely missing required path was accepted.' }
    return $observed
}
$ordinary=Join-Path $owned 'ordinary.bin'
[IO.File]::WriteAllText($ordinary,'synthetic ordinary file')
if ((Assert-NextPath -Path $ordinary -Within $owned -MustExist) -cne $ordinary) { throw 'Ordinary existing file identity changed.' }
$longDirectory=Join-Path $owned 'long-tree'
while ($longDirectory.Length -lt 340) { $longDirectory=Join-Path $longDirectory 'synthetic segment with space and 中文 0123456789' }
if ($longDirectory.Length -gt 410) { throw 'Long-path fixture exceeded its bound.' }
[IO.Directory]::CreateDirectory($longDirectory) | Out-Null
$longFile=Join-Path $longDirectory 'leaf.bin'
[IO.File]::WriteAllText($longFile,'synthetic long-path file')
if (-not [IO.Directory]::Exists($longDirectory) -or -not [IO.File]::Exists($longFile)) { throw 'The independent .NET fixture was not created.' }
$enumerated=@(Get-ChildItem -LiteralPath $longDirectory -Force -File)
if ($enumerated.Count -ne 1 -or $enumerated[0].FullName -cne $longFile) { throw 'Independent long-path enumeration did not find the fixture.' }
$rawDirectory=[NextRawPathObservation]::Inspect($longDirectory)
$rawFile=[NextRawPathObservation]::Inspect($longFile)
foreach ($path in @($longDirectory,$longFile)) {
    $actual=Assert-NextPath -Path $path -Within $owned -MustExist
    if ($actual.StartsWith('\\?\') -or $actual -cne $path) { throw 'Long-path canonical result is not the same ordinary DOS path.' }
}
Assert-NextInstallTree -Path $owned -OwnedRoot $root
$missingLeaf=Require-Missing (Join-Path $longDirectory 'missing.bin')
$missingParentPath=Join-Path (Join-Path $longDirectory 'missing-parent') 'child.bin'
$missingParent=Require-Missing $missingParentPath
if ((Assert-NextPath -Path $missingParentPath -Within $owned) -cne $missingParentPath) { throw 'Safe uncreated suffix changed identity.' }
# A file returned by enumeration may disappear; extended-path support must not
# convert that stale inventory into permission to accept missing entries.
[IO.File]::Delete($longFile)
$staleInventory=Require-Missing $enumerated[0].FullName
$sibling=Join-Path $root 'owned-sibling'
[IO.Directory]::CreateDirectory($sibling) | Out-Null
$escaped=$false
try { $null=Assert-NextPath -Path $sibling -Within $owned -MustExist } catch {
    if ($_.Exception.Message -ne 'Canonical path escaped its owned parent.') { throw }; $escaped=$true
}
if (-not $escaped) { throw 'Sibling-prefix ownership escape was accepted.' }
foreach ($invalid in @('relative','C:relative','\relative','//server/share','\\server\share','\\?\C:\owned','//?/C:/owned','\\.\C:\owned','\??\C:\owned','C:\owned:stream','C:\owned\trailing.','C:\owned\trailing ','C:\owned\NUL.txt')) {
    $rejected=$false
    try { $null=[NextPathGuard]::LocalDrivePath($invalid) } catch { $rejected=$true }
    if (-not $rejected) { throw 'An external namespace or ambiguous DOS alias was accepted.' }
}
$longLink=Join-Path $longDirectory 'junction'
New-Item -ItemType Junction -Path $longLink -Target $other | Out-Null
foreach ($path in @($longLink,(Join-Path $longLink 'unchanged.bin'),(Join-Path $longLink 'missing/child'))) {
    $rejected=$false
    try { $null=Assert-NextPath -Path $path -Within $owned } catch {
        if ($_.Exception.Message -notlike '*Reparse point or junction rejected:*') { throw }; $rejected=$true
    }
    if (-not $rejected) { throw 'A long-path junction ancestor was accepted.' }
}
$longEmptyTarget=Join-Path $root 'removed-long-link-target'
[IO.Directory]::CreateDirectory($longEmptyTarget) | Out-Null
$longDangling=Join-Path $longDirectory 'dangling'
New-Item -ItemType Junction -Path $longDangling -Target $longEmptyTarget | Out-Null
[IO.Directory]::Delete($longEmptyTarget)
$rejected=$false
try { $null=Assert-NextPath -Path (Join-Path $longDangling 'not-created') -Within $owned } catch {
    if ($_.Exception.Message -notlike '*Reparse point or junction rejected:*') { throw }; $rejected=$true
}
if (-not $rejected) { throw 'A long-path dangling junction ancestor was accepted.' }
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
$evidence=Assert-NextPath -Path (Join-Path $temporary 'dsh-next-installer-evidence/windows') -Within $temporary
[IO.Directory]::CreateDirectory($evidence) | Out-Null
@{ ordinary=$true; longDirectoryLength=$longDirectory.Length; longFileLength=$longFile.Length;
    rawNonExtended=@{ directory=$rawDirectory; file=$rawFile }; extendedExistingPassed=$true;
    missingLeaf=$missingLeaf; missingParent=$missingParent; staleInventory=$staleInventory;
    safeUncreatedSuffix=$true; namespaceAliasesRejected=$true; siblingEscapeRejected=$true;
    liveAndDanglingJunctionsRejected=$true; uninstallTreeReparseRejected=$true; outsideSentinelPreserved=$true;
    scope='Synthetic native path regression only; Ca missing-path cause remains unproven' } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'path-guard-native.json') -Encoding utf8
Write-Output 'Native ordinary/long paths, missing and stale entries, live/dangling junctions, ownership and namespace negative controls passed.'
