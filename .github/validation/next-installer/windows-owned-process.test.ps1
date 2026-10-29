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
. (Join-Path $PSScriptRoot 'windows-vctip-policy.ps1')
# The pure eligibility gate never authorizes action by basename, pass counters, or a partial job inventory.
$baseline = [NextOwnedProcess+ToolCandidate]::new()
$baseline.policyPresent=$true; $baseline.rootCode=0; $baseline.queryState='complete'; $baseline.assigned=1; $baseline.listed=1; $baseline.observedCount=1; $baseline.state='running'
$baseline.expectedPath='C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC\14.0.1\bin\Hostx64\x64\vctip.exe'
$baseline.imagePath=$baseline.expectedPath; $baseline.created=20; $baseline.rootCreated=10; $baseline.rootExited=30
if (-not [NextOwnedProcess]::IsToolCandidate($baseline)) { throw 'Verified tool candidate predicate rejected its complete input.' }
foreach ($change in @(@{policyPresent=$false},@{rootCode=1},@{timeBudgetExceeded=$true},@{outputExceeded=$true},@{truncated=$true},@{queryState='query-failed'},@{assigned=2},@{listed=2},@{observedCount=2},@{state='unknown'},@{imagePath='C:\Temp\vctip.exe'},@{created=31},@{created=9},@{rootCreated=0})) {
    $candidate = [NextOwnedProcess+ToolCandidate]::new()
    foreach ($field in $baseline.GetType().GetFields()) { $field.SetValue($candidate,$field.GetValue($baseline)) }
    foreach ($key in $change.Keys) { $candidate.$key = $change[$key] }
    if ([NextOwnedProcess]::IsToolCandidate($candidate)) { throw 'Unverified tool candidate was accepted.' }
}
# Accounting totals catch an unknown child even when it has already exited between PID snapshots.
if (-not [NextOwnedProcess]::IsCleanupInventory($true,10,10,0,0,0,0,123)) { throw 'An empty unchanged job was rejected.' }
if (-not [NextOwnedProcess]::IsCleanupInventory($true,10,10,1,1,1,123,123)) { throw 'Known candidate accounting lag was rejected.' }
foreach ($arguments in @(@($true,10,11,0,0,0,0,123),@($true,10,9,0,0,0,0,123),@($false,10,10,0,0,0,0,123),@($true,10,10,1,1,1,999,123),@($true,10,10,2,2,2,123,123),@($true,0,0,0,0,0,0,123))) {
    if ([NextOwnedProcess]::IsCleanupInventory($arguments[0],$arguments[1],$arguments[2],$arguments[3],$arguments[4],$arguments[5],$arguments[6],$arguments[7])) { throw 'Unknown, short-lived, partial or multi-member cleanup inventory was accepted.' }
}
foreach ($pair in @(@('NotSigned','Microsoft Corporation'),@('Valid','OpenJS Foundation'),@('UnknownError','Microsoft Corporation'))) {
    $failed=$false; try { Assert-NextMicrosoftSigner -Status $pair[0] -Publisher $pair[1] } catch { $failed=$true }
    if (-not $failed) { throw 'Non-Microsoft or invalid signature was accepted.' }
}
foreach ($scope in @('package-v1-preflight','package-v3','smoke-profile-tests','package-v1-attest','fresh-install-v1','../escape','PACKAGE-V1')) {
    $rejected=$false
    try { $null=New-NextVerifiedVctipPolicy -WorkingDirectory $root -EvidenceDirectory $root -Scope $scope }
    catch {
        if ($_.Exception -isnot [System.Management.Automation.ParameterBindingException] -or
            $_.Exception.GetType().FullName -cne 'System.Management.Automation.ParameterBindingValidationException' -or
            $_.CategoryInfo.Reason -cne 'ParameterBindingValidationException' -or
            $_.FullyQualifiedErrorId -cne 'ParameterArgumentValidationError,New-NextVerifiedVctipPolicy' -or
            $_.Exception.ErrorId -cne 'ParameterArgumentValidationError' -or $_.Exception.ParameterName -cne 'Scope') { throw }
        $rejected=$true
    }
    if (-not $rejected) { throw 'A non-compiler command scope was accepted by the vendor policy factory.' }
}
$policy = New-NextVerifiedVctipPolicy -WorkingDirectory $root -EvidenceDirectory $root
try {
    $never = Join-Path $root 'wrong-hash-must-not-start'
    $failed=$false
    try { $null=Invoke-NextOwnedProcess -FilePath $node -Arguments @('-e','require("fs").writeFileSync(process.argv[1],"unsafe")',$never) -WorkingDirectory $root -TimeoutSeconds 10 -EvidencePrefix (Join-Path $root 'wrong-tool-hash') -VerifiedToolPath $policy.Path -VerifiedToolSha256 ('0' * 64) } catch { $failed=$true }
    if (-not $failed -or (Test-Path -LiteralPath $never) -or -not [NextOwnedProcess]::SafeToStart) { throw 'Changed tool hash executed a process or corrupted ownership state.' }
    $policyMarker=Join-Path $root 'policy-descendant.json'; $policyHeartbeat=Join-Path $root 'policy-heartbeat.bin'
    $failed=$false
    try { $null=Invoke-NextOwnedProcess -FilePath $node -Arguments @($exitEntry,$child,$policyMarker,$policyHeartbeat) -WorkingDirectory $root -TimeoutSeconds 25 -EvidencePrefix (Join-Path $root 'node-with-vendor-policy') -VerifiedToolPath $policy.Path -VerifiedToolSha256 $policy.Sha256 } catch { $failed=$true }
    $record=Get-Content -LiteralPath (Join-Path $root 'node-with-vendor-policy.result.json') -Raw | ConvertFrom-Json
    if (-not $failed -or $record.exitCode -ne 0 -or -not $record.timedOut -or -not $record.rootExitGraceExceeded -or -not $record.quiescenceConfirmed -or $null -ne $record.toolCleanup -or $record.naturalQuiescence) { throw 'A valid vendor policy excused an ordinary Node descendant.' }
    $pidValue=(Get-Content -LiteralPath $policyMarker -Raw | ConvertFrom-Json).pid
    if ($null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { throw 'Rejected ordinary descendant survived cleanup.' }
} finally { $policy.FileLock.Dispose() }
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
