<# Pin one installed Microsoft compiler telemetry helper without changing the Visual Studio installation. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-path-guard.ps1')
function Assert-NextMicrosoftSigner {
    param([string]$Status, [string]$Publisher)
    if ($Status -ne 'Valid' -or $Publisher -cne 'Microsoft Corporation') { throw 'A valid Microsoft Authenticode publisher is required.' }
}
function Get-NextLockedHash {
    param([Parameter(Mandatory)][IO.FileStream]$Stream)
    $Stream.Position = 0
    $hash = [Security.Cryptography.SHA256]::HashData($Stream)
    $Stream.Position = 0
    return [Convert]::ToHexString($hash).ToLowerInvariant()
}
function Get-NextMicrosoftSignature {
    param([Parameter(Mandatory)][string]$Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $publisher = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) }
    Assert-NextMicrosoftSigner -Status ([string]$signature.Status) -Publisher $publisher
    return @{ status=[string]$signature.Status; publisher=$publisher; thumbprint=$signature.SignerCertificate.Thumbprint }
}
function New-NextVerifiedVctipPolicy {
    param([Parameter(Mandatory)][string]$WorkingDirectory, [Parameter(Mandatory)][string]$EvidenceDirectory,
        [ValidateSet('desktop-tests','package-v1','package-v2',IgnoreCase=$false)][string]$Scope = 'desktop-tests')
    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $where = Assert-NextPath -Path (Join-Path $programFilesX86 'Microsoft Visual Studio/Installer/vswhere.exe') -Within $programFilesX86 -MustExist
    $whereLock = [IO.File]::Open($where,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $whereSignature = Get-NextMicrosoftSignature -Path $where
        $whereHash = Get-NextLockedHash -Stream $whereLock
        $prefix = Join-Path $EvidenceDirectory ('vctip-' + $Scope + '-vswhere')
        $null = Invoke-NextOwnedProcess -FilePath $where -Arguments @('-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath') -WorkingDirectory $WorkingDirectory -TimeoutSeconds 30 -EvidencePrefix $prefix
        $selection = (Get-Content -LiteralPath ($prefix + '.stdout.log') -Raw).Trim()
        if (-not $selection -or $selection.Contains("`n") -or $selection.Contains("`r")) { throw 'Exactly one official Visual Studio installation must be selected.' }
    } finally { $whereLock.Dispose() }
    $vs = Assert-NextPath -Path $selection -MustExist
    $approvedRoots = @((Join-Path $programFiles 'Microsoft Visual Studio'),(Join-Path $programFilesX86 'Microsoft Visual Studio'))
    if (-not ($approvedRoots | Where-Object { $vs.StartsWith($_.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase) })) { throw 'Selected Visual Studio is outside its official Program Files location.' }
    $versionFile = Assert-NextPath -Path (Join-Path $vs 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Within $vs -MustExist
    $version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected default MSVC toolset version.' }
    $path = Assert-NextPath -Path (Join-Path $vs ('VC/Tools/MSVC/' + $version + '/bin/Hostx64/x64/vctip.exe')) -Within $vs -MustExist
    # Deny writes and deletion before signature/hash inspection and until the owned command has settled.
    $fileLock = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $signature = Get-NextMicrosoftSignature -Path $path
        $hash = Get-NextLockedHash -Stream $fileLock
        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($path)
        if ($info.CompanyName -cne 'Microsoft Corporation' -or [string]::IsNullOrWhiteSpace($info.FileVersion)) { throw 'Compiler telemetry metadata is not Microsoft tool metadata.' }
        $reader = [IO.BinaryReader]::new($fileLock,[Text.Encoding]::UTF8,$true)
        try {
            if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Compiler telemetry helper is not a PE.' }
            $fileLock.Position = 0x3c
            $offset = $reader.ReadUInt32()
            if ($offset -lt 64 -or $offset + 6 -gt $fileLock.Length) { throw 'Compiler telemetry PE header is invalid.' }
            $fileLock.Position = $offset
            if ($reader.ReadUInt32() -ne 0x4550) { throw 'Compiler telemetry PE signature is invalid.' }
            $machine = $reader.ReadUInt16()
            if ($machine -notin @(0x014c,0x8664)) { throw 'Compiler telemetry helper has an unexpected PE machine.' }
        } finally { $reader.Dispose(); $fileLock.Position = 0 }
        @{ toolPath=$path; sha256=$hash; bytes=$fileLock.Length; signature=$signature; fileVersion=$info.FileVersion;
            companyName=$info.CompanyName; productName=$info.ProductName; machine=$machine; vsInstallation=$vs; toolsetVersion=$version;
            vswhereSha256=$whereHash; vswhereSignature=$whereSignature; source=$env:EXPECTED_PRODUCT_SHA;
            scope=$Scope; purpose='Read-only pinned Microsoft compiler telemetry identity for this explicit owned compiler command' } |
            ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory ('vctip-' + $Scope + '-identity.json')) -Encoding utf8
        return [pscustomobject]@{ Path=$path; Sha256=$hash; FileLock=$fileLock; Scope=$Scope }
    } catch { $fileLock.Dispose(); throw }
}
