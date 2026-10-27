import { spawn } from 'node:child_process'

/** Run one owned Linux process group; a timeout kills descendants before returning failure. */
export async function runCommand(command, args, { cwd, timeout, env = process.env }) {
  if (process.platform !== 'linux') throw new Error('This validation runner requires its reviewed Linux process-group semantics')
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let error
  let termination
  let timer
  const killGroup = signal => {
    try { process.kill(-child.pid, signal) } catch (failure) {
      if (failure.code !== 'ESRCH') throw failure
    }
  }
  const stop = cause => {
    if (termination) return
    error = cause
    killGroup('SIGTERM')
    termination = new Promise(resolve => {
      setTimeout(() => { killGroup('SIGKILL'); resolve() }, 10_000)
    })
  }
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
  const result = await completion
  clearTimeout(timer)
  if (termination) await termination
  return { ...result, error, output }
}
