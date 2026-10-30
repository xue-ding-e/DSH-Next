/** Narrow real-installed-app probe. Run ONLY inside the existing Windows JobObject.
 * Node never kills a PID. On failure it exits nonzero and the enclosing reviewed
 * owner handles descendants. No registration call, UI click, login or inference.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { SOURCE, PROFILE_PATCH, runtimeEnvironment, inspectorEndpoint, verifyRuntimeIdentity, verifyProtocolSnapshots } from './protocol-policy.mjs'

export class Inspector {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.scripts = new Map(); this.contextId = undefined; this.contextInvalid = false
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data)
        if (message.method === 'Runtime.executionContextCreated' && message.params.context.auxData?.isDefault) {
          const id = message.params.context.id
          if (this.contextId !== undefined && this.contextId !== id) this.contextInvalid = true
          else this.contextId = id
        }
        if (message.method === 'Runtime.executionContextsCleared' ||
            (message.method === 'Runtime.executionContextDestroyed' && message.params.executionContextId === this.contextId)) this.contextInvalid = true
        if (message.method === 'Debugger.scriptParsed') this.scripts.set(message.params.url, message.params.scriptId)
        const waiter = this.pending.get(message.id)
        if (waiter) { this.pending.delete(message.id); message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result) }
      } catch (error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear() }
    })
    socket.addEventListener('close', () => { for (const waiter of this.pending.values()) waiter.reject(Error('owned inspector closed')); this.pending.clear() })
  }
  send(method, params = {}) {
    const id = ++this.next
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })) })
  }
  async read(expression) {
    assert(this.contextId !== undefined && !this.contextInvalid, 'unique default main context is missing or changed')
    const reply = await this.send('Runtime.evaluate', { contextId: this.contextId, expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true })
    assert(!reply.exceptionDetails, 'owned main evaluation failed')
    return reply.result.value
  }
}
export const IDENTITY_EXPRESSION = `(() => {
 const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path'),crypto=require('crypto');
 const main=path.join(app.getAppPath(),'lib','main.js');const source=fs.readFileSync(main,'utf8');
 return {pid:process.pid,execPath:process.execPath,appPath:app.getAppPath(),version:app.getVersion(),electron:process.versions.electron,
 isPackaged:app.isPackaged,ready:app.isReady(),defaultProtocol:app.isDefaultProtocolClient('dsh-next'),
 userData:app.getPath('userData'),logs:app.getPath('logs'),home:require('os').homedir(),cwd:process.cwd(),
 nextHome:process.env.DSH_NEXT_HOME,dshHome:process.env.DSH_HOME,telemetryDisabled:process.env.DSH_TELEMETRY_DISABLED,
 runAsNode:!!process.env.ELECTRON_RUN_AS_NODE,scriptPath:main,scriptSha256:crypto.createHash('sha256').update(source).digest('hex'),
 registrationSites:(source.match(/\\.setAsDefaultProtocolClient\\s*\\(/g)||[]).length,
 windows:BrowserWindow.getAllWindows().map(w=>({url:w.webContents.getURL(),visible:w.isVisible()}))};})()`
export const QUIT_EXPRESSION = `(() => { const {app}=require('electron'); setImmediate(() => app.quit()); return true; })()`
const sha = data => createHash('sha256').update(data).digest('hex')
async function hash(path) { const h=createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex') }

export function loadedScriptMatches(url, scriptPath) {
  try { return win32.normalize(fileURLToPath(url, { windows: true })).toLowerCase() === win32.normalize(scriptPath).toLowerCase() } catch { return false }
}
export async function main(requestPath) {
  assert.equal(process.platform, 'win32', 'no application launch outside native Windows')
  const request = JSON.parse(readFileSync(requestPath, 'utf8').replace(/^\uFEFF/, ''))
  assert.equal(request.executionAuthorized, true, 'probe is not reviewed/authorized')
  assert.equal(request.source, SOURCE)
  const root = resolve(request.runtimeRoot), evidence = resolve(request.evidence)
  assert(!existsSync(root), 'runtime root must be completely new')
  assert.equal(realpathSync(request.exe).toLowerCase(), resolve(request.exe).toLowerCase())
  const attestation = JSON.parse(readFileSync(request.attestation, 'utf8').replace(/^\uFEFF/, ''))
  assert.equal(attestation.source, SOURCE); assert.equal(attestation.version, request.version)
  const asar = join(dirname(request.exe), 'resources', 'app.asar')
  assert.equal(await hash(request.exe), attestation.executableSha256)
  assert.equal(await hash(asar), attestation.asarSha256)
  mkdirSync(root); mkdirSync(evidence, { recursive: true })
  const env = runtimeEnvironment(request.systemRoot, root)
  for (const key of ['HOME','APPDATA','LOCALAPPDATA','TEMP','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','DSH_HOME','DSH_NEXT_HOME']) mkdirSync(env[key], { recursive: true })
  mkdirSync(join(root,'userData'))
  writeFileSync(join(env.DSH_NEXT_HOME,'cordis.patch.yml'), PROFILE_PATCH, { flag: 'wx' })
  const statusPath=join(evidence,'protocol-runtime.json')
  const status={ source:SOURCE,exeSha256:attestation.executableSha256,asarSha256:attestation.asarSha256,version:request.version,qualified:false,
    scope:'Synthetic real GUI registration and normal quit only; public anonymous GitHub update GETs permitted; not network containment or user-session migration' }
  const save=()=>writeFileSync(statusPath,JSON.stringify(status,null,2)+'\n'); save()
  const snapshot = name => {
    const output=join(evidence,name+'.json')
    execFileSync(request.pwsh, ['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./registry-snapshot.ps1',import.meta.url)),'-Output',output], { env,timeout:10000,stdio:'pipe',shell:false })
    return JSON.parse(readFileSync(output,'utf8').replace(/^\uFEFF/,''))
  }
  const before=snapshot('protocol-before')
  // Fail before launching if any user view already belongs to a foreign handler.
  const expectedCommand=`"${request.exe}" "%1"`
  for(const entry of before) if(entry.hive==='CurrentUser'&&entry.exists) assert.equal(entry.command,expectedCommand)
  let failure, child, client, timer
  try {
    timer=setTimeout(()=>{status.failure='probe hard deadline; outer JobObject must confirm cleanup';save();process.exit(1)},120000)
    child=spawn(request.exe,['--inspect=127.0.0.1:0','--user-data-dir='+join(root,'userData'),'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run'],{cwd:root,env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:false})
    let endpoint, bytes=0, tail='', spawnFailure
    const exit=new Promise(resolve=>{child.once('error',error=>{spawnFailure=error});child.once('close',(code,signal)=>resolve({code,signal}))})
    const count=chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024){status.failure='bounded output exceeded; outer owner cleanup required';save();process.exit(1)}}
    child.stdout.on('data',count)
    child.stderr.on('data',chunk=>{
      count(chunk);tail+=chunk.toString()
      const lines=tail.split(/\r?\n/);tail=lines.pop()
      for(const line of lines) if(line.startsWith('Debugger listening on ')) {
        try {const value=inspectorEndpoint(line);assert(!endpoint||endpoint===value);endpoint=value} catch(error){spawnFailure=error}
      }
      if(bytes>2*1024*1024){status.failure='bounded output exceeded; outer owner cleanup required';save();process.exit(1)}
    })
    const deadline=Date.now()+100000
    while(!endpoint){assert(!spawnFailure,spawnFailure?.message);assert(child.exitCode===null&&child.signalCode===null,'app exited before owned endpoint');assert(Date.now()<deadline,'no owned loopback endpoint');await delay(40)}
    const socket=new WebSocket(endpoint)
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Error('owned inspector connection failed')),{once:true})})
    client=new Inspector(socket);await client.send('Runtime.enable');await client.send('Debugger.enable')
    let identity
    while(true){
      assert(Date.now()<deadline,'real welcome/registration was not observed')
      identity=await client.read(IDENTITY_EXPRESSION)
      assert.equal(identity.pid,child.pid);assert.equal(identity.execPath.toLowerCase(),request.exe.toLowerCase())
      if(identity.ready&&identity.defaultProtocol&&identity.windows.some(w=>/\/renderer\/welcome\.html(?:[?#]|$)/.test(w.url)))break
      await delay(100)
    }
    verifyRuntimeIdentity(identity,{exe:request.exe,version:request.version,root})
    assert.equal(identity.registrationSites,1,'original main registration site is not unique')
    const scriptEntry=[...client.scripts].filter(([url])=>loadedScriptMatches(url,identity.scriptPath))
    assert.equal(scriptEntry.length,1,'exact installed main is not the loaded script')
    const script=await client.send('Debugger.getScriptSource',{scriptId:scriptEntry[0][1]})
    assert.equal(sha(script.scriptSource),identity.scriptSha256,'loaded main differs from attested ASAR main')
    status.identity=identity;save()
    const after=snapshot('protocol-after');verifyProtocolSnapshots(before,after,request.exe)
    assert.equal(await client.read(QUIT_EXPRESSION),true)
    socket.close();const result=await exit
    assert.equal(result.code,0);assert.equal(result.signal,null)
    assert.equal(await hash(request.exe),attestation.executableSha256);assert.equal(await hash(asar),attestation.asarSha256)
    assert.equal(readFileSync(join(env.DSH_NEXT_HOME,'cordis.patch.yml'),'utf8'),PROFILE_PATCH)
    status.appExit=result;status.qualified=true;status.outerJobNaturalQuiescence='still required by caller';save()
  }catch(error){failure=error;status.failure=error.message;save()}
  finally{clearTimeout(timer);client?.socket.close()}
  // No throw/unwind cleanup can pretend the application tree is gone.
  if(failure){console.error('Protocol probe failed; preserve synthetic fixture and use outer owned-job cleanup:',failure.message);process.exit(1)}
}
if(import.meta.main)await main(process.argv[2])
