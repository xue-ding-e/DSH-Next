import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

for (const signal of ['SIGINT', 'SIGTERM']) test(`owned descendants stop and source restores after ${signal}`, { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-owned-cancellation-'))
  const source = join(dir, 'source.txt'), heartbeat = join(dir, 'heartbeat'), pidFile = join(dir, 'pid'), ready = join(dir, 'owner-ready')
  writeFileSync(source, 'original')
  const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20)`
  const child = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`
  const ownerFile = join(dir, 'owner.mjs')
  writeFileSync(ownerFile, `import{readFileSync,writeFileSync}from'node:fs';import{runCommand}from${JSON.stringify(new URL('./run-command.mjs', import.meta.url).href)};
const p=${JSON.stringify(source)},saved=readFileSync(p);writeFileSync(p,'base-for-red');
try{const pending=runCommand(process.execPath,['-e',${JSON.stringify(child)}],{cwd:${JSON.stringify(dir)},timeout:20000});if(process.listenerCount('SIGINT')!==1||process.listenerCount('SIGTERM')!==1)throw Error('owner signal handlers are not registered');writeFileSync(${JSON.stringify(ready)},'ready');const r=await pending;if(!r.error?.message.includes('cancelled by ${signal}'))throw Error('cancellation was not propagated');}finally{writeFileSync(p,saved)};
if(process.listenerCount('SIGINT')||process.listenerCount('SIGTERM'))throw Error('signal listener leaked');`)
  const owner = spawn(process.execPath, [ownerFile], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; owner.stderr.on('data', chunk => { stderr += chunk })
  const closed = once(owner, 'close')
  const escalation = []
  try {
    const deadline = Date.now() + 5000
    // A descendant heartbeat does not establish that the owner registered its signal handlers.
    while (!existsSync(ready) || !existsSync(heartbeat)) { assert(Date.now() < deadline, 'owner handlers and owned grandchild did not become ready'); await delay(20) }
    assert.equal(readFileSync(source, 'utf8'), 'base-for-red')
    const interruptedAt = Date.now()
    owner.kill(signal)
    // Apply the actual Actions escalation deadlines to the step-entry Node process.
    if (signal === 'SIGINT') escalation.push(setTimeout(() => owner.kill('SIGTERM'), 7500))
    escalation.push(setTimeout(() => owner.kill('SIGKILL'), signal === 'SIGINT' ? 10000 : 2500))
    const [code, exitSignal] = await closed
    escalation.forEach(clearTimeout)
    assert.equal(exitSignal, null, `owner ended by ${exitSignal} after ${Date.now() - interruptedAt} ms; ${stderr}`)
    assert.equal(code, 0, stderr)
    assert(Date.now() - interruptedAt < (signal === 'SIGINT' ? 7000 : 2000), 'restoration missed runner cancellation deadline')
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), createHash('sha256').update('original').digest('hex'))
    const size = readFileSync(heartbeat).length
    await delay(150)
    assert.equal(readFileSync(heartbeat).length, size, 'owned grandchild still running after restoration')
  } finally {
    escalation.forEach(clearTimeout)
    // Test-owned safety cleanup only; never signal an unrelated PID or process group.
    if (existsSync(pidFile)) { try { process.kill(-Number(readFileSync(pidFile)), 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    if (owner.exitCode === null) owner.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
