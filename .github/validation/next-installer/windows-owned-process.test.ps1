<# Native-only negative controls run before dependency installation or an installer. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable hosted Windows only.' }
. (Join-Path $PSScriptRoot 'windows-owned-process.ps1')
$root = Join-Path $env:RUNNER_TEMP ('next-process-controls-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$node = (Get-Command node.exe).Source
$result = Invoke-NextOwnedProcess -FilePath $node -Arguments @('-e','process.stdout.write("owned-success")') -WorkingDirectory $root -TimeoutSeconds 10 -EvidencePrefix (Join-Path $root 'success')
if ($result.exitCode -ne 0 -or $result.timedOut) { throw 'Successful process was not observed.' }
$entry = Join-Path $root 'parent.mjs'
$marker = Join-Path $root 'descendant.json'
$heartbeat = Join-Path $root 'heartbeat.bin'
$child = 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>fs.appendFileSync(process.argv[2],"."),20)'
@'
import { spawn } from 'node:child_process';
const child=spawn(process.execPath,['-e',process.argv[2],process.argv[3],process.argv[4]],{stdio:'ignore',detached:true});
child.unref(); setInterval(()=>{},1000);
'@ | Set-Content -LiteralPath $entry -Encoding utf8
$failed = $false
try { $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @($entry,$child,$marker,$heartbeat) -WorkingDirectory $root -TimeoutSeconds 3 -EvidencePrefix (Join-Path $root 'timeout') }
catch { $failed = $true }
if (-not $failed) { throw 'Timeout was reported as successful.' }
$record = Get-Content -LiteralPath (Join-Path $root 'timeout.result.json') -Raw | ConvertFrom-Json
if (-not $record.timedOut -or $record.exitCode -eq 0) { throw 'Timeout and process exit must be independently reported.' }
if (-not (Test-Path -LiteralPath $marker) -or -not (Test-Path -LiteralPath $heartbeat)) { throw 'Owned descendant never reached the timeout fixture.' }
$pidValue = (Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).pid
if ($null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { throw 'Owned descendant survived job termination.' }
$length = (Get-Item -LiteralPath $heartbeat).Length
Start-Sleep -Milliseconds 150
if ((Get-Item -LiteralPath $heartbeat).Length -ne $length) { throw 'Owned descendant mutated data after cleanup.' }
if (-not [NextOwnedProcess]::SafeToStart) { throw 'Confirmed timeout cleanup unnecessarily poisoned this session.' }
$failed = $false
try {
    # A single synchronous write followed by exit 0 must still fail the final output-length gate.
    $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @('-e','require("fs").writeSync(1,Buffer.alloc(33*1024*1024,120))') -WorkingDirectory $root -TimeoutSeconds 10 -EvidencePrefix (Join-Path $root 'fast-output')
} catch { $failed = $true }
$record = Get-Content -LiteralPath (Join-Path $root 'fast-output.result.json') -Raw | ConvertFrom-Json
if (-not $failed -or -not $record.outputExceeded -or (Get-Item -LiteralPath (Join-Path $root 'fast-output.stdout.log')).Length -le 32MB) { throw 'Fast successful oversized output bypassed the byte bound.' }
if (-not [NextOwnedProcess]::SafeToStart) { throw 'Confirmed output-limit cleanup unnecessarily poisoned this session.' }
$failed = $false
$completedMarker = Join-Path $root 'injected-completed.txt'
try {
    $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @('-e','require("fs").writeFileSync(process.argv[1],"owned")',$completedMarker) -WorkingDirectory $root -TimeoutSeconds 10 -EvidencePrefix (Join-Path $root 'uncertain-cleanup') -SimulateUncertainCleanup
} catch { $failed = $true }
if (-not $failed -or [NextOwnedProcess]::SafeToStart -or -not (Test-Path -LiteralPath $completedMarker)) { throw 'Injected unconfirmed cleanup did not poison the session.' }
$forbiddenMarker = Join-Path $root 'must-not-start.txt'
$failed = $false
try {
    $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @('-e','require("fs").writeFileSync(process.argv[1],"unsafe")',$forbiddenMarker) -WorkingDirectory $root -TimeoutSeconds 10 -EvidencePrefix (Join-Path $root 'forbidden-start')
} catch { $failed = $true }
if (-not $failed -or (Test-Path -LiteralPath $forbiddenMarker) -or (Test-Path -LiteralPath (Join-Path $root 'forbidden-start.stdout.log'))) { throw 'A process started after ownership became uncertain.' }
# Leave the session poisoned deliberately. A later workflow step is a new disposable PowerShell process.
Write-Output 'Native owned-process success, timeout descendants, fast output and fail-closed session controls passed.'
