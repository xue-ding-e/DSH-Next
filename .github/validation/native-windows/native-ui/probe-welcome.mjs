// Real installed renderer only; no Playwright browser launch, scaffold, preload calls, or credentials.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {writeFileSync,readFileSync} from 'node:fs'
import {verifySessionMenus} from './probe-session-menus.mjs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {loopbackEndpoint,installedTarget} from './cdp-endpoint.mjs'
const [portText,installedRoot,reportPath,ownerText,pwsh]=process.argv.slice(2),port=Number(portText)
assert(installedRoot&&reportPath&&pwsh&&/^[1-9][0-9]*$/.test(ownerText))
const listenerSnapshots=[]
function attest(){
 const text=execFileSync(pwsh,['-NoProfile','-File',fileURLToPath(new URL('./listener-policy.ps1',import.meta.url)),'-OwnerPid',ownerText,'-Port',portText],{encoding:'utf8',timeout:10000})
 const snapshot=JSON.parse(text);assert.equal(snapshot.ownerPid,Number(ownerText));assert.equal(snapshot.port,port);assert(snapshot.listeners.length>0)
 for(const l of snapshot.listeners){assert(['127.0.0.1','::1'].includes(l.address));assert.equal(l.pid,Number(ownerText))}
 listenerSnapshots.push(snapshot)
}
const endpoint=loopbackEndpoint('http://127.0.0.1:'+port+'/json/list',port)
const welcome=pathToFileURL(join(installedRoot,'resources','app.asar','renderer','welcome.html')).href
const until=Date.now()+45000
async function targets(){
 const r=await fetch(endpoint,{redirect:'error',signal:AbortSignal.timeout(3000)})
 assert(r.ok);const data=await r.json();assert(Array.isArray(data));return data
}
async function waitTarget(predicate){
 while(Date.now()<until){const found=(await targets()).find(predicate);if(found){installedTarget(found,welcome);return found}await new Promise(r=>setTimeout(r,200))}
 throw Error('installed renderer target deadline')
}
async function connect(target){
 attest()
 const ws=new WebSocket(loopbackEndpoint(target.webSocketDebuggerUrl,port,{websocket:true}))
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('CDP connect timeout'))},3000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP connect failure'))},{once:true})})
 try{attest()}catch(error){ws.close();throw error} // Non-atomic post-connect ownership recheck.
 let next=1;const pending=new Map(),errors=[]
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)})
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP command timeout '+method))},3000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})
 const close=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'))}pending.clear();ws.close()}
 await send('Runtime.enable')
 return {send,close,errors}
}
async function click(c,selector){
 let value
 while(Date.now()<until){
  const r=await c.send('Runtime.evaluate',{expression:'(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return r.width>0&&r.height>0?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()',returnByValue:true})
  value=r.result?.value;if(value)break;await new Promise(r=>setTimeout(r,100))
 }
 assert(value,'missing visible enabled '+selector)
 await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...value})
 await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...value})
}
const evidence={phase:'C1 installed synthetic session menus',sessionMenus:'pending',automaticUpdate:'not run'}
let c
try{
 const target=await waitTarget(t=>t.type==='page'&&t.url===welcome)
 c=await connect(target);await click(c,'#api-key');await click(c,'#skip-key');evidence.welcome='existing API-key page -> skip, no key entered'
 assert.deepEqual(c.errors,[]);evidence.welcomeExceptions=c.errors;c.close();c=null
 const app=await waitTarget(t=>t.type==='page'&&t.url.startsWith('dsh-app://app/'))
 c=await connect(app)
 let ready=false
 while(Date.now()<until){
  const r=await c.send('Runtime.evaluate',{expression:"({url:location.href,root:!!document.querySelector('#root')?.children.length,newSession:[...document.querySelectorAll('button')].some(x=>x.getAttribute('aria-label')==='New session'||x.getAttribute('aria-label')==='新建会话')})",returnByValue:true})
  const v=r.result?.value;if(v?.root&&v.newSession){evidence.renderer=v;ready=true;break}await new Promise(r=>setTimeout(r,200))
 }
 assert(ready,'real installed client did not become ready');assert.deepEqual(c.errors,[])
 const seed=JSON.parse(readFileSync(process.env.DSH_ACCEPTANCE_SEED_REPORT,'utf8'))
 evidence.sessionMenus=await verifySessionMenus(c,seed)
 attest();evidence.listenerSnapshots=listenerSnapshots;evidence.listenerGuarantee='repeated non-atomic PID/loopback observations';
 evidence.rendererExceptions=c.errors;writeFileSync(reportPath,JSON.stringify(evidence,null,2))
}finally{c?.close()}
