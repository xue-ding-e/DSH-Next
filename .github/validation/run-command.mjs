import { spawn } from 'node:child_process'

/** Run one owned Linux process group; timeout or cancellation kills descendants before caller restoration. */
export async function runCommand(command, args, { cwd, timeout, env = process.env }) {
  if (process.platform !== 'linux') throw new Error('This validation runner requires its reviewed Linux process-group semantics')
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let error
  let termination
  let finishTermination
  let timer
  const killGroup = signal => {
    try { process.kill(-child.pid, signal) } catch (failure) {
      if (failure.code !== 'ESRCH') throw failure
    }
  }
  const stop = (cause, grace = 10_000) => {
    if (termination) {
      if (grace < 10_000) finishTermination()
      return
    }
    error = cause
    killGroup('SIGTERM')
    termination = new Promise(resolve => {
      const graceTimer = setTimeout(() => finishTermination(), grace)
      finishTermination = () => { clearTimeout(graceTimer); killGroup('SIGKILL'); resolve() }
    })
  }
  // Cancellation must finish before Actions escalates SIGTERM to a hard kill after 2.5s.
  // Keep the parent alive through owned-group cleanup so caller finally blocks can restore source.
  const onInterrupt = () => stop(new Error('validation command cancelled by SIGINT'), 1000)
  const onTerminate = () => stop(new Error('validation command cancelled by SIGTERM'), 1000)
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  const collect = (destination, chunk) => {
    destination.write(chunk)
    if (output.length + chunk.length > 32 * 1024 * 1024) {
      stop(new Error('validation command output exceeded the bounded capture'))
    } else output += chunk.toString()
  }
  child.stdout.on('data', chunk => collect(process.stdout, chunk))
  child.stderr.on('data', chunk => collect(process.stderr, chunk))
  const completion = new Promise(resolve => {
    child.on('error', failure => { error = failure })
    child.on('close', (status, signal) => resolve({ status, signal }))
  })
  timer = setTimeout(() => stop(new Error(`validation command exceeded ${timeout} ms`)), timeout)
  try {
    const result = await completion
    clearTimeout(timer)
    if (termination) await termination
    return { ...result, error, output }
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
}
