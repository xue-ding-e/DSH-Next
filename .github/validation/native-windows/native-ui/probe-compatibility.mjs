import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {readdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {CASES} from './synthetic-sessions.mjs'
// Use the real row context-menu gesture qualified in C1, independent of hover.
// This chooses an existing interaction, not a product CSS or menu implementation fix.
export async function openSessionMenu(c,wait,id){
 assert(CASES.some(s=>s.id===id),'Only synthetic session IDs are permitted')
 const selector='[data-row-key="session:'+id+'"]',q=JSON.stringify
 const point=await wait(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`,v=>!!v)
 await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
 for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'right',clickCount:1,...point})
 await wait(`document.querySelectorAll('[role="menu"]').length===1`)
}
// Preserve the original D1 failure even if the independent check is inconclusive.
export async function independentCheck(original,check){
 let result;try{result=await check()}catch(error){if(!original)throw error}
 if(original)throw original
 return result
}
// Best-effort diagnostic failure must never replace D1 or suppress independent D2.
// The abort signal also prevents delayed CDP completions from writing after timeout.
export async function isolateDiagnostic(operation,timeoutMs=7000){
 const controller=new AbortController();let timer
 try{
  assert(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=7000)
  await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Diagnostic deadline exceeded'))},timeoutMs)})])
  return {status:'completed'}
 }catch(error){return {status:'failed',error:String(error?.message??error).slice(0,500)}}
 finally{clearTimeout(timer);controller.abort()}
}
export function diagnosticExpression(){
 return `(()=>{const ids=${JSON.stringify(CASES.map(x=>x.id))};
 const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
 const shape=e=>{if(!e)return null;const c=getComputedStyle(e);return {tag:e.tagName,role:e.getAttribute('role'),display:c.display,visibility:c.visibility,pointerEvents:c.pointerEvents,rect:rect(e)}};
 return {safeOrigin:location.protocol==='dsh-app:'&&location.hostname==='app',viewport:{width:innerWidth,height:innerHeight},rows:ids.map(id=>{
 const e=document.querySelector('[data-row-key="session:'+id+'"]'),b=e?.querySelector('button[aria-haspopup="menu"]'),r=e?.getBoundingClientRect(),top=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;
 const actions=b?.parentElement??e?.querySelector('[class*="rowActions"]');const ancestors=[];for(let p=b?.parentElement??e,i=0;p&&i<6;p=p.parentElement,i++)ancestors.push(shape(p));
 return {id,rowExists:!!e,buttonExists:!!b,buttonDisabled:b?.disabled??null,row:shape(e),button:shape(b),rowActions:shape(actions),ancestors,rowHovered:e?.matches(':hover')??false,selected:e?.getAttribute('aria-selected')==='true',centerHitsRow:!!(e&&top&&e.contains(top)),centerHit:shape(top),centerHitSyntheticId:ids.includes(top?.closest('[data-row-key]')?.getAttribute('data-row-key')?.slice(8))?top.closest('[data-row-key]').getAttribute('data-row-key').slice(8):null,children:e?[...e.children].slice(0,12).map(shape):[]};
 }),menus:document.querySelectorAll('[role="menu"]').length,dialogs:document.querySelectorAll('[role="dialog"]').length};})()`
}
export async function captureDiagnostic(c,reportPath,stage,error,signal){
 const report={stage,originalError:String(error.message).slice(0,2000),snapshot:null,screenshot:'not captured'}
 try{
 const r=await c.send('Runtime.evaluate',{expression:diagnosticExpression(),returnByValue:true});signal?.throwIfAborted();assert(!r.exceptionDetails);report.snapshot=r.result?.value
 const v=report.snapshot;assert(v?.safeOrigin&&v.rows.some(x=>x.rowExists),'Not the expected synthetic installed renderer')
 assert(v.viewport.width>0&&v.viewport.height>0&&v.viewport.width<=4096&&v.viewport.height<=4096,'Viewport outside bounded capture')
 const image=await c.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});signal?.throwIfAborted();assert(typeof image.data==='string'&&image.data.length<8*1024*1024,'Capture too large')
 writeFileSync(reportPath+'.failure.png',Buffer.from(image.data,'base64'));report.screenshot='synthetic installed renderer viewport only'
 }catch(e){report.diagnosticError=String(e.message).slice(0,500)}
 signal?.throwIfAborted();writeFileSync(reportPath+'.diagnostic.json',JSON.stringify(report,null,2))
}
export async function verifyCompatibility(c,{stage,reportPath,ownerText,pwsh}){
 assert(['old','new'].includes(stage));const deadline=Date.now()+50000
 const q=JSON.stringify,row=id=>'[data-row-key="session:'+id+'"]'
 const ev=async expression=>{const r=await c.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert(!r.exceptionDetails);return r.result?.value}
 async function wait(e,p=x=>x===true,until=deadline){while(Date.now()<until){const v=await ev(e);if(p(v))return v;await new Promise(r=>setTimeout(r,100))}throw Error('D1 condition timed out '+e)}
 async function hit(expr,until=deadline){const p=await wait(`(()=>{const e=${expr};if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`,v=>!!v,until);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p})}
 const named=(names,scope='document')=>hit(`[...${scope}.querySelectorAll('button,[role="menuitem"]')].find(e=>${q(names)}.some(n=>e.textContent.trim()===n||e.getAttribute('aria-label')===n||(e.getAttribute('role')==='menuitem'&&e.textContent.trim().startsWith(n))))`)
 const key=async(key,code=key,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key,code,modifiers})}
 const menu=id=>openSessionMenu(c,wait,id)
 const A=CASES[0],B=CASES[1]
 let d1,d1Error,diagnosticStatus
 try{
 if(stage==='old'){
  await named(['View options','视图选项']);await named(['In one list','单列表'])
  await menu(A.id);await named(['Rename','重命名']);await hit("document.querySelector('[role=dialog] input')");await key('a','KeyA',2);await c.send('Input.insertText',{text:'SYNTHETIC migration title A'});await key('Enter')
  await wait(`document.querySelector(${q(row(A.id))})?.textContent.includes('SYNTHETIC migration title A')`)
  await menu(A.id);await named(['Pin session','置顶会话'])
  await key(',','Comma',2);await wait(`!!document.querySelector('[data-shortcut-modal="settings"]')`)
  await named(['General','通用'],"document.querySelector('[data-shortcut-modal=\"settings\"]')")
  await named(['English'],"document.querySelector('[data-shortcut-modal=\"settings\"]')");await named(['中文'])
  await wait(`document.querySelector('[data-shortcut-modal="settings"]')?.textContent.includes('语言')`);await key('Escape')
 }
 // New phase never repairs/restores preferences: it only observes and opens existing content.
 await wait(`document.querySelector(${q(row(A.id))})?.textContent.includes('SYNTHETIC migration title A')`)
 await wait(`[...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='新建会话')`)
 for(const s of CASES){await hit(`document.querySelector(${q(row(s.id))})`);await wait(`document.querySelector(${q(row(s.id))})?.getAttribute('aria-selected')==='true'`);await wait(`[...document.querySelectorAll('[data-message-bubble]')].some(e=>e.textContent.includes(${q(s.text)}))`)}
 await menu(A.id);await wait(`[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.trim()==='取消置顶')`);await key('Escape')
 d1={stage,locale:'zh',titleA:'SYNTHETIC migration title A',pinnedA:true,sessions:CASES,semanticChecksPassed:true,automaticUpgrade:'not tested'}
 writeFileSync(reportPath+'.compatibility.json',JSON.stringify(d1,null,2))
 }catch(error){d1Error=error;diagnosticStatus=await isolateDiagnostic(signal=>captureDiagnostic(c,reportPath,stage,error,signal))}
 return independentCheck(d1Error,async()=>{
 // D2 is independent: a missing native menu capability must not erase D1 evidence.
 const d2={stage,status:'pending',priorD1Diagnostic:diagnosticStatus,networkRequestPaths:'unknown; existing journal does not record URLs',downloadInvoked:false,installInvoked:false}
 try{
  // D2 gets its own bounded input window even when D1's wait deadline expired.
  await key('Escape');await key('Escape')
  const dir=process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR
  const journal=()=>readdirSync(dir).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(dir,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
  const before=journal().length
  await hit("document.querySelector('[data-windows-menu]')?.shadowRoot?.querySelector('button')",Date.now()+5000)
  const invocation=JSON.parse(execFileSync(pwsh,['-NoProfile','-File',fileURLToPath(new URL('./invoke-check-update.ps1',import.meta.url)),'-OwnerPid',ownerText,'-ReportPath',reportPath+'.native-menu.json'],{encoding:'utf8',timeout:12000}))
  assert.equal(invocation.ownerPid,Number(ownerText));d2.invocation=invocation
  const end=Date.now()+15000;let records
  do{records=journal();if(records.slice(before).some(x=>x.event==='check-requested')&&records.slice(before).some(x=>x.event==='state'&&!['checking'].includes(x.phase)))break;await new Promise(r=>setTimeout(r,200))}while(Date.now()<end)
  assert(records.slice(before).some(x=>x.event==='check-requested'),'Manual check not journalled')
  const terminal=records.slice(before).filter(x=>x.event==='state'&&!['checking'].includes(x.phase)).at(-1)
  assert(terminal,'No bounded update-check result');d2.status='observed';d2.result=terminal;d2.journal=records
 }catch(e){d2.status='inconclusive';d2.reason=String(e.message).slice(0,500)}
 // Journal is whitelist-only and belongs exclusively to this synthetic runner.
 const all=readdirSync(process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
 assert(!all.some(x=>['download-requested','install-confirmed'].includes(x.event)||['downloading','downloaded','ready','installing'].includes(x.phase)),'Unexpected updater mutation')
 writeFileSync(reportPath+'.update-check.json',JSON.stringify(d2,null,2))
 return {compatibility:d1,updateCheck:d2}
 })
}
