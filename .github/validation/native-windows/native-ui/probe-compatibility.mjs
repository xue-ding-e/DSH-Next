import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {readdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {CASES} from './synthetic-sessions.mjs'
export async function verifyCompatibility(c,{stage,reportPath,ownerText,pwsh}){
 assert(['old','new'].includes(stage));const deadline=Date.now()+50000
 const q=JSON.stringify,row=id=>'[data-row-key="session:'+id+'"]'
 const ev=async expression=>{const r=await c.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert(!r.exceptionDetails);return r.result?.value}
 async function wait(e,p=x=>x===true){while(Date.now()<deadline){const v=await ev(e);if(p(v))return v;await new Promise(r=>setTimeout(r,100))}throw Error('D1 condition timed out '+e)}
 async function hit(expr){const p=await wait(`(()=>{const e=${expr};if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`,v=>!!v);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p})}
 const named=(names,scope='document')=>hit(`[...${scope}.querySelectorAll('button,[role="menuitem"]')].find(e=>${q(names)}.some(n=>e.textContent.trim()===n||e.getAttribute('aria-label')===n||(e.getAttribute('role')==='menuitem'&&e.textContent.trim().startsWith(n))))`)
 const key=async(key,code=key,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key,code,modifiers})}
 const menu=async(id)=>hit(`document.querySelector(${q(row(id)+' button[aria-haspopup="menu"]')})`)
 const A=CASES[0],B=CASES[1]
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
 const d1={stage,locale:'zh',titleA:'SYNTHETIC migration title A',pinnedA:true,sessions:CASES,semanticChecksPassed:true,automaticUpgrade:'not tested'}
 writeFileSync(reportPath+'.compatibility.json',JSON.stringify(d1,null,2))
 // D2 is independent: a missing native menu capability must not erase D1 evidence.
 const d2={stage,status:'pending',networkRequestPaths:'unknown; existing journal does not record URLs',downloadInvoked:false,installInvoked:false}
 try{
  const dir=process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR
  const journal=()=>readdirSync(dir).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(dir,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
  const before=journal().length
  await hit("document.querySelector('[data-windows-menu]')?.shadowRoot?.querySelector('button')")
  const invocation=JSON.parse(execFileSync(pwsh,['-NoProfile','-File',fileURLToPath(new URL('./invoke-check-update.ps1',import.meta.url)),'-OwnerPid',ownerText],{encoding:'utf8',timeout:12000}))
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
}
