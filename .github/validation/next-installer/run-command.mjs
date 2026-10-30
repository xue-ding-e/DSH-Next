import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Linux command ownership lives in the frozen WNOWAIT/pidfd Python owner.
 * Private stdin conveys cancellation/parent EOF; Node never signals a numeric PID.
 * Only a confirmed final reap permits caller restoration. Unknown ownership exits
 * without unwinding caller finally blocks, retaining the fixture and evidence.
 * Hosted hard cancellation can interrupt cleanup; no deadline/residual guarantee.
 */
export async function runCommand(command, args, { cwd, timeout, env = process.env }) {
  if (process.platform !== 'linux') throw new Error('This validation runner requires its reviewed Linux owner')
  const parent = join(process.env.RUNNER_TEMP || tmpdir(), 'dsh-next-installer-evidence', 'linux')
  mkdirSync(parent, { recursive: true })
  const evidence = mkdtempSync(join(parent, 'owned-command-'))
  const state = value => writeFileSync(join(evidence, 'wrapper-status.json'), JSON.stringify(value) + '\n')
  state({ cleanupConfirmed: false, state: 'pending-or-interrupted', scope: 'Hosted hard cancellation may prevent final owner receipt' })
  const child = spawn('python3', ['-B', '-u', fileURLToPath(new URL('./owner-adapter.py', import.meta.url))],
    { stdio: ['pipe', 'ignore', 'pipe'] })
  let cancellation, spawnError, ownerStderr = ''
  const cancel = signal => {
    cancellation ??= new Error(`validation command cancelled by ${signal}`)
    if (!child.stdin.destroyed) child.stdin.write('cancel\n')
  }
  const onInterrupt = () => cancel('SIGINT'), onTerminate = () => cancel('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  // EPIPE is resolved by the final receipt, never a best-effort cleanup claim.
  child.stdin.on('error', () => {})
  child.stderr.on('data', chunk => { if (ownerStderr.length < 65536) ownerStderr += chunk.toString() })
  const completion = new Promise(resolve => {
    child.on('error', error => { spawnError = error })
    child.on('close', (status, signal) => resolve({ status, signal }))
  })
  child.stdin.write(JSON.stringify({ argv: [command, ...args], cwd, timeout_ms: timeout, env, evidence }) + '\n')
  const completed = await completion
  child.stdin.destroy()
  process.off('SIGINT', onInterrupt)
  process.off('SIGTERM', onTerminate)
  let receipt
  try { receipt = JSON.parse(readFileSync(join(evidence, 'receipt.json'), 'utf8')) } catch {}
  if (spawnError || completed.status !== 0 || completed.signal || receipt?.schema !== 1 ||
      receipt.cleanupConfirmed !== true || !receipt.record ||
      Object.keys(receipt.record.survivors ?? { unknown: true }).length || !Number.isInteger(receipt.record.exit_code)) {
    state({ cleanupConfirmed: false, state: 'unknown', status: completed.status, signal: completed.signal, spawnError: spawnError?.message })
    console.error('Owner completion is unconfirmed; preserve fixture and evidence:', evidence, ownerStderr)
    // Do not throw: caller finally must not restore a potentially active fixture.
    process.exit(1)
  }
  state({ cleanupConfirmed: true, state: 'owner-completed', record: receipt.record })
  const stdout = readFileSync(join(evidence, 'owner-command.stdout.log'), 'utf8')
  const stderr = readFileSync(join(evidence, 'owner-command.stderr.log'), 'utf8')
  process.stdout.write(stdout); process.stderr.write(stderr)
  const record = receipt.record
  const error = cancellation || (receipt.failure ? new Error(receipt.failure) : undefined)
  return { status: record.exit_code, signal: null, error, cancelled: Boolean(cancellation || receipt.cancelled), output: stdout + stderr,
    ownership: { cleanupConfirmed: true, evidence, record } }
}
