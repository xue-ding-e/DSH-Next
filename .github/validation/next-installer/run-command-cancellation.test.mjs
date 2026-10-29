import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { runCommand } from './run-command.mjs'

const wrapper = new URL('./run-command.mjs', import.meta.url).href
const ownerBytes = readFileSync(new URL('./owned-supervisor.py', import.meta.url))
const fixture = () => mkdtempSync(join(tmpdir(), 'dsh-owned-cancellation-'))
async function until(check, milliseconds = 12_000) {
  const deadline = Date.now() + milliseconds
  while (!check()) { assert(Date.now() < deadline, 'bounded fixture did not reach expected state'); await delay(30) }
}
function actor(script, dir, env = process.env) {
  const file = join(dir, 'actor.mjs'); writeFileSync(file, script)
  const child = spawn(process.execPath, [file], { env: { ...env, RUNNER_TEMP: dir }, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''; child.stdout.on('data', x => { text += x }); child.stderr.on('data', x => { text += x })
  const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, text })))
  return { done }
}
function receipts(dir) {
  const parent = join(dir, 'dsh-next-installer-evidence', 'linux')
  if (!existsSync(parent)) return []
  return readdirSync(parent).flatMap(name => {
    const file = join(parent, name, 'receipt.json')
    return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8'))] : []
  })
}
function confirmed(receipt) {
  assert.equal(receipt.cleanupConfirmed, true)
  assert.deepEqual(receipt.record.survivors, {})
  assert(Number.isInteger(receipt.record.exit_code))
}
const childCode = heartbeat => `const fs=require('node:fs');process.on('SIGTERM',()=>{});const t=setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);setTimeout(()=>{clearInterval(t);process.exit(0)},8000)`
async function stopped(heartbeat) {
  const size = readFileSync(heartbeat).length; await delay(180)
  assert.equal(readFileSync(heartbeat).length, size, 'fixture still writes after cleanup receipt')
}

test('normal and nonzero commands preserve real exit status and final reap', { timeout: 15_000 }, async () => {
  const dir = fixture()
  for (const code of [0, 7]) {
    const result = await runCommand(process.execPath, ['-e', `console.log('owned-output');process.exit(${code})`], { cwd: dir, timeout: 3000 })
    assert.equal(result.status, code); assert.equal(Boolean(result.error), code !== 0)
    assert.match(result.output, /owned-output/); assert.equal(result.ownership.cleanupConfirmed, true)
  }
  rmSync(dir, { recursive: true })
})

test('timeout cleans resistant descendants before returning', { timeout: 15_000 }, async () => {
  const dir = fixture(), heartbeat = join(dir, 'heartbeat')
  const result = await runCommand(process.execPath, ['-e', childCode(heartbeat)], { cwd: dir, timeout: 500 })
  assert.match(result.error.message, /timeout/)
  assert.equal(result.ownership.record.reason, 'timeout')
  assert.deepEqual(result.ownership.record.survivors, {})
  await stopped(heartbeat); rmSync(dir, { recursive: true })
})

for (const signal of ['SIGINT', 'SIGTERM']) test(`pipe-mediated ${signal} waits for confirmed cleanup before restoration`, { timeout: 20_000 }, async () => {
  const dir = fixture(), heartbeat = join(dir, 'heartbeat'), source = join(dir, 'source')
  writeFileSync(source, 'original')
  const script = `import{readFileSync,writeFileSync,existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';import{runCommand}from${JSON.stringify(wrapper)};
const p=${JSON.stringify(source)},saved=readFileSync(p);writeFileSync(p,'synthetic-active');
try{const pending=runCommand(process.execPath,['-e',${JSON.stringify(childCode(heartbeat))}],{cwd:${JSON.stringify(dir)},timeout:10000});while(!existsSync(${JSON.stringify(heartbeat)}))await delay(20);process.kill(process.pid,${JSON.stringify(signal)});const result=await pending;if(!result.error?.message.includes('cancelled by ${signal}')||!result.ownership.cleanupConfirmed)throw Error('cancel not confirmed');}finally{writeFileSync(p,saved)};
if(process.listenerCount('SIGINT')||process.listenerCount('SIGTERM'))throw Error('listener leak');`
  const result = await actor(script, dir).done
  assert.equal(result.code, 0, result.text); assert.equal(result.signal, null)
  confirmed(receipts(dir)[0]); assert.equal(readFileSync(source, 'utf8'), 'original')
  await stopped(heartbeat); rmSync(dir, { recursive: true })
})

test('command parent exit leaving a descendant fails and cleans before return', { timeout: 15_000 }, async () => {
  const dir = fixture(), heartbeat = join(dir, 'heartbeat')
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode(heartbeat))}],{stdio:'ignore'});setTimeout(()=>process.exit(0),300)`
  const result = await runCommand(process.execPath, ['-e', code], { cwd: dir, timeout: 4000 })
  assert.equal(result.ownership.record.reason, 'surviving_descendants_after_parent_exit')
  assert(result.error); assert.deepEqual(result.ownership.record.survivors, {})
  await stopped(heartbeat); rmSync(dir, { recursive: true })
})

test('wrapper early exit closes private pipe; Python cleans without restoring fixture', { timeout: 20_000 }, async () => {
  const dir = fixture(), heartbeat = join(dir, 'heartbeat'), source = join(dir, 'source')
  writeFileSync(source, 'synthetic-active')
  const script = `import{existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';import{runCommand}from${JSON.stringify(wrapper)};
runCommand(process.execPath,['-e',${JSON.stringify(childCode(heartbeat))}],{cwd:${JSON.stringify(dir)},timeout:10000});while(!existsSync(${JSON.stringify(heartbeat)}))await delay(20);process.exit(23);`
  const result = await actor(script, dir).done; assert.equal(result.code, 23)
  await until(() => receipts(dir).length === 1)
  const receipt = receipts(dir)[0]; confirmed(receipt); assert.match(receipt.cancelled, /pipe closed/)
  assert.equal(readFileSync(source, 'utf8'), 'synthetic-active')
  await stopped(heartbeat); rmSync(dir, { recursive: true })
})

test('missing owner receipt exits without unwinding restoration or deleting fixture', { timeout: 10_000 }, async () => {
  const dir = fixture(), bin = join(dir, 'bin'), source = join(dir, 'source'); mkdirSync(bin)
  writeFileSync(join(bin, 'python3'), '#!/bin/sh\nexit 9\n', { mode: 0o700 }); writeFileSync(source, 'original')
  const script = `import{writeFileSync}from'node:fs';import{runCommand}from${JSON.stringify(wrapper)};writeFileSync(${JSON.stringify(source)},'synthetic-active');try{await runCommand('not-run',[],{cwd:${JSON.stringify(dir)},timeout:1000})}finally{writeFileSync(${JSON.stringify(source)},'WRONGLY-RESTORED')}`
  const result = await actor(script, dir, { ...process.env, PATH: bin }).done
  assert.equal(result.code, 1); assert.match(result.text, /unconfirmed; preserve fixture/)
  assert.equal(readFileSync(source, 'utf8'), 'synthetic-active')
  const evidenceParent = join(dir, 'dsh-next-installer-evidence', 'linux')
  const status = JSON.parse(readFileSync(join(evidenceParent, readdirSync(evidenceParent)[0], 'wrapper-status.json'), 'utf8'))
  assert.equal(status.cleanupConfirmed, false); assert.equal(status.state, 'unknown')
  // Fake owner never launched a child, so this test alone can safely remove it.
  rmSync(dir, { recursive: true })
})

test('after-reap numeric-kill regression is excluded by frozen owner and pipe-only wrapper', async () => {
  // Reproduce the old logic using a fake kill sink only, never an OS signal.
  const calls = []; let reaped = false
  const pending = new Promise(resolve => setTimeout(() => { calls.push({ reaped, signal: 'SIGKILL' }); resolve() }, 5))
  reaped = true; await pending; assert.deepEqual(calls, [{ reaped: true, signal: 'SIGKILL' }])
  const source = readFileSync(new URL('./run-command.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /process\.kill|child\.kill|setTimeout/)
  assert.match(source, /child\.stdin\.write\('cancel/)
  assert.match(source, /'python3', \['-B'/)
  assert.match(source, /pending-or-interrupted/)
  assert.equal(createHash('sha256').update(ownerBytes).digest('hex'), 'bc48ae5497f44cbdd97d73bce1a67c36e970c3dd13995336ce992de6c750b62c')
  const owner = ownerBytes.toString(); assert.match(owner, /os\.WNOWAIT/); assert.match(owner, /signal\.pidfd_send_signal/)
  assert(owner.indexOf('remaining = owned_members(child.pid, known)') < owner.indexOf('child.wait(timeout=1)'))
})
