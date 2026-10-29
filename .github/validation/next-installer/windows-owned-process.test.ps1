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
# A successful parent cannot make its still-running owned child a successful command.
$exitEntry = Join-Path $root 'parent-exits.mjs'
$exitMarker = Join-Path $root 'exit-descendant.json'
$exitHeartbeat = Join-Path $root 'exit-heartbeat.bin'
@'
import { spawn } from 'node:child_process'; import { existsSync } from 'node:fs';
const child=spawn(process.execPath,['-e',process.argv[2],process.argv[3],process.argv[4]],{stdio:'ignore',detached:true});
child.unref(); const start=Date.now(); const timer=setInterval(()=>{
  if(existsSync(process.argv[3])){clearInterval(timer);process.exit(0)}
  if(Date.now()-start>5000)process.exit(2)
},20);
'@ | Set-Content -LiteralPath $exitEntry -Encoding utf8
$failed = $false
try { $null = Invoke-NextOwnedProcess -FilePath $node -Arguments @($exitEntry,$child,$exitMarker,$exitHeartbeat) -WorkingDirectory $root -TimeoutSeconds 25 -EvidencePrefix (Join-Path $root 'parent-exit') }
catch { $failed = $true }
$record = Get-Content -LiteralPath (Join-Path $root 'parent-exit.result.json') -Raw | ConvertFrom-Json
if (-not $failed -or -not $record.timedOut -or $record.exitCode -ne 0 -or $record.terminationReason -ne 'root-exit-descendants' -or -not $record.quiescenceConfirmed) { throw 'Parent exit 0 bypassed the descendant grace and cleanup gate.' }
if ($record.rootExitObservedMs -lt 0 -or ($record.elapsedMs - $record.rootExitObservedMs) -lt 15000 -or $record.elapsedMs -ge 25000) { throw 'Root-exit timeline lost its existing 15-second bound.' }
$pidValue = (Get-Content -LiteralPath $exitMarker -Raw | ConvertFrom-Json).pid
if ($record.snapshots.Count -ne 2 -or $record.snapshots[0].phase -ne 'root-exit' -or $record.snapshots[1].phase -ne 'before-owned-termination') { throw 'Owned lifecycle diagnostic phases were not retained.' }
foreach ($snapshot in $record.snapshots) {
    $observed = @($snapshot.processes | Where-Object { $_.pid -eq $pidValue })
    if (@($snapshot.processes | Where-Object { $_.pid -eq $PID }).Count -ne 0) { throw 'Observer included its unowned PowerShell caller.' }
    if ($snapshot.queryState -ne 'complete' -or $snapshot.truncated -or $observed.Count -ne 1) { throw 'Synthetic owned descendant was not observed completely.' }
    if ($snapshot.root.exitCode -ne 0 -or $observed[0].imageBasename -ne 'node.exe' -or $observed[0].state -ne 'running' -or $null -eq $observed[0].createdUtc) { throw 'Owned PID image, creation or root exit diagnostic was incorrect.' }
    if ($null -ne $observed[0].parentPid) {
        if ($observed[0].parentQueryStatus -ne 'reported' -or $observed[0].parentPid -ne $record.pid -or $observed[0].parentRelation -ne 'reported-parent-matches-observed-owned-lifetime') { throw 'A reported synthetic parent did not match its known owned lifetime.' }
    } elseif ($observed[0].parentRelation -ne 'unknown' -or $observed[0].parentQueryStatus -notmatch '^(unavailable|ntstatus-[0-9A-F]{8}|unexpected-size|pid-mismatch|unavailable-parent-id|query-exception-[A-Za-z0-9]+)$') {
        throw 'An unavailable optional parent query fabricated a relationship or omitted its status.'
    }
}
if ($null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { throw 'Exited parent left its owned descendant running.' }
$length = (Get-Item -LiteralPath $exitHeartbeat).Length
Start-Sleep -Milliseconds 150
if ((Get-Item -LiteralPath $exitHeartbeat).Length -ne $length -or -not [NextOwnedProcess]::SafeToStart) { throw 'Descendant writes or uncertain cleanup survived the failed parent-exit case.' }
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
Write-Output 'Native owned-process success, timeout descendants, parent-exit diagnostics, fast output and fail-closed session controls passed.'
