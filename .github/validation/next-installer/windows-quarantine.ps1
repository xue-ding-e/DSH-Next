<# Preserve only the exact unsigned NSIS for diagnosis, never as a qualified package or install input. #>
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Quarantine is limited to disposable hosted Windows.' }
. (Join-Path $PSScriptRoot 'windows-path-guard.ps1')
function Save-NextUnqualifiedInstaller {
    param([Parameter(Mandatory)][string]$Product,
        [Parameter(Mandatory)][ValidateSet('package-v1','package-v2',IgnoreCase=$false)][string]$Label)
    $manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
    $version=if ($Label -ceq 'package-v1') { $manifest.version } else { $manifest.upgradeVersion }
    if ($version -notmatch '^0\.2\.1-rc\.3\.20261029\.[12]$' -or $manifest.source -notmatch '^[a-f0-9]{40}$' -or $env:EXPECTED_CONTROL_SHA -notmatch '^[a-f0-9]{40}$') { throw 'Reviewed quarantine identity is missing.' }
    $productRoot=Assert-NextPath -Path $Product -MustExist
    $source=Assert-NextPath -Path (Join-Path $productRoot ('apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/dsh-next-'+$version+'-win-x64-unsigned.exe')) -Within $productRoot -MustExist
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'The exact quarantine source is not a regular installer file.' }
    $temporary=Assert-NextPath -Path $env:RUNNER_TEMP -MustExist
    $directory=Assert-NextPath -Path (Join-Path $temporary 'dsh-next-installer-quarantine') -Within $temporary
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $destination=Assert-NextPath -Path (Join-Path $directory ($Label+'-unqualified.exe')) -Within $directory
    $partial=Assert-NextPath -Path ($destination+'.partial') -Within $directory
    $receipt=Assert-NextPath -Path (Join-Path $directory ($Label+'-unqualified.json')) -Within $directory
    foreach ($path in @($destination,$partial,$receipt)) { if (Test-Path -LiteralPath $path) { throw 'Quarantine evidence must never overwrite an existing entry.' } }
    # FileShare.Read denies writes/deletion for the complete signature/hash/copy/hash interval.
    # This does not claim that a separate recursive directory inventory is an atomic snapshot.
    $inputStream=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if ((Assert-NextPath -Path $source -Within $productRoot -MustExist) -cne $source) { throw 'Locked installer path identity changed.' }
        $signature=Get-AuthenticodeSignature -LiteralPath $source
        if ($signature.Status -ne 'NotSigned') { throw 'Only the actual explicitly unsigned NSIS may be quarantined.' }
        $bytes=$inputStream.Length
        if ($bytes -le 0 -or $bytes -gt 2147483648) { throw 'Quarantine installer exceeded the 2 GiB byte bound.' }
        $timer=[Diagnostics.Stopwatch]::StartNew()
        $hashAlgorithm=[Security.Cryptography.SHA256]::Create()
        try {
            $sourceHash=[Convert]::ToHexString($hashAlgorithm.ComputeHash($inputStream)).ToLowerInvariant()
            $inputStream.Position=0
            $outputStream=[IO.File]::Open($partial,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
            try {
                $buffer=[byte[]]::new(1048576); $copied=[long]0
                while (($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
                    if ($timer.Elapsed.TotalSeconds -gt 120 -or $copied+$count -gt $bytes) { throw 'Quarantine copy exceeded its reviewed time/byte bound.' }
                    $outputStream.Write($buffer,0,$count); $copied+=$count
                }
                $outputStream.Flush($true); $outputStream.Position=0
                $copyHash=[Convert]::ToHexString($hashAlgorithm.ComputeHash($outputStream)).ToLowerInvariant()
                if ($timer.Elapsed.TotalSeconds -gt 120 -or $copied -ne $bytes -or $inputStream.Length -ne $bytes -or $sourceHash -cne $copyHash) { throw 'Locked quarantine source/copy size or hash mismatch.' }
            } finally { $outputStream.Dispose() }
        } finally { $hashAlgorithm.Dispose() }
    } finally { $inputStream.Dispose() }
    $null=Assert-NextPath -Path $partial -Within $directory -MustExist
    $null=Assert-NextPath -Path $destination -Within $directory
    [IO.File]::Move($partial,$destination) # no overwrite; incomplete copies are never uploaded
    $record=@{ source=$manifest.source; control=$env:EXPECTED_CONTROL_SHA; repositoryId=$manifest.repositoryId;
        version=$version; label=$Label; bytes=$bytes; sha256=$sourceHash; signatureStatus='NotSigned';
        qualified=$false; installAuthorized=$false; publishAuthorized=$false;
        purpose='Diagnostic quarantine only; not a packages-index entry or a deliverable';
        verification='Exact owned NSIS only; source locked against write/delete during signature/hash/copy/hash';
        unverified=@('PE/ASAR package attestation','higher-version upgrade','installation lifecycle') } |
        ConvertTo-Json -Depth 6
    $receiptStream=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $recordBytes=[Text.UTF8Encoding]::new($false).GetBytes($record+"`n")
        $receiptStream.Write($recordBytes,0,$recordBytes.Length); $receiptStream.Flush($true)
    } finally { $receiptStream.Dispose() }
}
