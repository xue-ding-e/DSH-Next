# Dot-source after the existing windows-owned-process and windows-path-guard helpers.
# Caller inserts this AFTER installed PE/ASAR identity and BEFORE protocol assertions.
# A failure must retain synthetic fixture; do not delete registry keys to mask failure.
function Invoke-NextProtocolRuntime {
  param([Parameter(Mandatory)][string]$InstalledExe,
    [Parameter(Mandatory)][string]$Attestation,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$OwnedRoot,
    [Parameter(Mandatory)][string]$Evidence,
    [Parameter(Mandatory)][string]$Label,
    [Parameter(Mandatory)][bool]$ExecutionAuthorized,
    [Parameter(Mandatory)][string]$NodeExe,
    [Parameter(Mandatory)][string]$ExpectedNodeSha256)
  if (-not $ExecutionAuthorized) { throw 'Runtime lane not authorized.' }
  # Keep source/version coupled: neither a valid SHA nor a known version alone is enough.
  $baselinePair = $Source -ceq '270dd45091805cb504fdd39bf09d9ec596ca4150' -and $Version -ceq '0.2.1-rc.3.20261029.1'
  $fixedPair = $Source -ceq '097405ae7f990d34a17a2afe689db17df55932a3' -and $Version -ceq '0.2.1-rc.3.20261029.2'
  if (-not ($baselinePair -or $fixedPair)) { throw 'Unreviewed runtime source/version pair.' }
  if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY_ID -ne '1437727533') { throw 'Only the fresh hosted DSH validation account is supported.' }
  if ([Environment]::UserName -ne 'runneradmin') { throw 'Unexpected account.' }
  if ($Label -notmatch '^[a-z0-9-]+$') { throw 'Unsafe stage label.' }
  $root = Assert-NextPath -Path $OwnedRoot -Within $env:RUNNER_TEMP -MustExist
  $exe = Assert-NextPath -Path $InstalledExe -Within $root -MustExist
  $evidenceRoot = Assert-NextPath -Path $Evidence -Within $env:RUNNER_TEMP -MustExist
  $attest = Assert-NextPath -Path $Attestation -Within $evidenceRoot -MustExist
  $runtimeRoot = Assert-NextPath -Path (Join-Path $root ('runtime-' + $Label)) -Within $root
  $probeEvidence = Assert-NextPath -Path (Join-Path $evidenceRoot ('runtime-' + $Label)) -Within $evidenceRoot
  if ((Test-Path -LiteralPath $runtimeRoot) -or (Test-Path -LiteralPath $probeEvidence)) { throw 'Probe paths must be new.' }
  New-Item -ItemType Directory -Path $probeEvidence | Out-Null
  $request = Join-Path $probeEvidence 'request.json'
  @{ executionAuthorized=$ExecutionAuthorized;source=$Source;
    exe=$exe;attestation=$attest;version=$Version;runtimeRoot=$runtimeRoot;evidence=$probeEvidence;
    systemRoot=$env:SystemRoot;pwsh=(Join-Path $PSHOME 'pwsh.exe') } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $request -Encoding utf8
  # Caller supplies the absolute setup-node 24.19.0 toolcache path and its
  # previously recorded SHA256. Never resolve an executable through ambient PATH.
  $node = Assert-NextPath -Path $NodeExe -Within $env:RUNNER_TOOL_CACHE -MustExist
  if ($ExpectedNodeSha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedNodeSha256) { throw 'Node tool identity mismatch.' }
  $nodeInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($node)
  if ($nodeInfo.ProductVersion -notmatch '^24\.19\.0(?:\D|$)') { throw 'Expected reviewed Node 24.19.0.' }
  @{path=$node;sha256=$ExpectedNodeSha256;version=$nodeInfo.ProductVersion} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probeEvidence 'node-identity.json') -Encoding utf8
  # The reviewed native owner inherits this process environment. Sanitize BEFORE
  # it creates Node, so NODE_OPTIONS and CI/model credentials cannot execute/leak
  # at Node startup. Restore the parent process environment even on owned failure.
  $saved = @{}
  [Environment]::GetEnvironmentVariables('Process').GetEnumerator() | ForEach-Object { $saved[$_.Key]=$_.Value }
  $probeHome = Join-Path $probeEvidence 'controller-home'
  New-Item -ItemType Directory -Path $probeHome | Out-Null
  $safe = @{
    SystemRoot=$saved['SystemRoot'];WINDIR=$saved['SystemRoot'];SystemDrive=[IO.Path]::GetPathRoot($saved['SystemRoot']).TrimEnd('\');
    PATH=(Join-Path $saved['SystemRoot'] 'System32');
    HOME=$probeHome;USERPROFILE=$probeHome;APPDATA=$probeHome;LOCALAPPDATA=$probeHome;TEMP=$probeHome;TMP=$probeHome
  }
  $result = Invoke-NextCleanEnvironment -Safe $safe -Action {
    Invoke-NextOwnedProcess -FilePath $node -Arguments @((Join-Path $PSScriptRoot 'protocol-runtime.mjs'),$request) -WorkingDirectory $root -TimeoutSeconds 150 -EvidencePrefix (Join-Path $probeEvidence 'owned')
  }
  if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedNodeSha256) { throw 'Node identity changed during probe.' }
  if (-not $result.naturalQuiescence -or -not $result.quiescenceConfirmed -or $result.timedOut -or $result.rootExitGraceExceeded -or $null -ne $result.toolCleanup) { throw 'Runtime did not exit naturally with owned job quiet; retain fixture.' }
  $receipt = Get-Content -LiteralPath (Join-Path $probeEvidence 'protocol-runtime.json') -Raw | ConvertFrom-Json
  if (-not $receipt.qualified -or $receipt.source -cne $Source -or $receipt.version -cne $Version -or $receipt.appExit.code -ne 0) { throw 'Runtime identity/quit receipt failed.' }
  return @{ runtime=$receipt; owner=$result }
}

# Isolated helper so startup-env behavior is tested without Windows or launching apps.
function Invoke-NextCleanEnvironment {
  param([Parameter(Mandatory)][hashtable]$Safe,[Parameter(Mandatory)][scriptblock]$Action)
  $saved = @{}
  [Environment]::GetEnvironmentVariables('Process').GetEnumerator() | ForEach-Object { $saved[$_.Key]=$_.Value }
  try {
    foreach ($key in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($key,$null,'Process') }
    foreach ($key in $Safe.Keys) { [Environment]::SetEnvironmentVariable($key,$Safe[$key],'Process') }
    & $Action
  } finally {
    $current = [Environment]::GetEnvironmentVariables('Process')
    foreach ($key in @($current.Keys)) { [Environment]::SetEnvironmentVariable($key,$null,'Process') }
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key],'Process') }
  }
}
