// Real CDP input against published renderer. DOM reads/focus only; no React/store/IPC calls.
import assert from 'node:assert/strict'
import {CASES} from './synthetic-sessions.mjs'
export async function verifySessionMenus(c,seed) {
 assert.equal(seed.contextsDisposed,true);assert.deepEqual(seed.sessions.map(x=>x.id),CASES.map(x=>x.id))
 for(const s of seed.sessions)assert(s.writerExcluded&&s.writerReleased&&s.readbackExact&&s.closedTurn)
 const end=Date.now()+75000, evidence={seed,checks:[],automaticUpdate:'not run',configurationMigration:'not run'}
 const evaluate=async expression=>{const r=await c.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result?.value}
 async function wait(expression,expected=true){while(Date.now()<end){const value=await evaluate(expression);if(typeof expected==='function'?expected(value):value===expected)return value;await new Promise(r=>setTimeout(r,100))}throw Error('C1 renderer wait failed: '+expression)}
 const row=id=>'[data-row-key="session:'+id+'"]', q=JSON.stringify
 const A=CASES[0],B=CASES[1],sel=id=>`document.querySelector(${q(row(id))})?.getAttribute('aria-selected')==='true'`
 async function mouse(selector,button='left'){
  const p=await wait(`(()=>{const e=document.querySelector(${q(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+Math.min(70,r.width/2),y:r.y+r.height/2}:null})()`,x=>!!x)
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p})
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button,clickCount:1,...p});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button,clickCount:1,...p})
 }
 async function key(key,code=key,modifiers=0){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers})}
 const count=`document.querySelectorAll('[role="menu"]').length`
 const labels=`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(e=>({text:e.textContent.trim(),disabled:e.getAttribute('aria-disabled')==='true'||e.disabled===true}))`
 async function menu(id=A.id){await mouse(row(id),'right');await wait(count,1);return evaluate(labels)}
 async function dismiss(){await key('Escape');await wait(count,0)}
 async function named(names,selector='[role="menu"] [role="menuitem"]'){
  const p=await wait(`(()=>{const e=[...document.querySelectorAll(${q(selector)})].find(e=>${q(names)}.some(n=>e.textContent.trim().startsWith(n)||e.getAttribute('aria-label')===n));if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`,x=>!!x)
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p})
 }
 async function content(s){await mouse(row(s.id));await wait(sel(s.id));await wait(`[...document.querySelectorAll('[data-message-bubble]')].some(e=>e.textContent.includes(${q(s.text)}))`)}
 // Choose the formal flat view, not client-store injection. Two exact persisted IDs must render.
 await named(['View options','视图选项'],'button');await named(['In one list','单列表']);
 for(const s of CASES)await content(s)
 await wait(sel(B.id))
 const before=await menu();for(const names of [['Pin session','置顶会话'],['Rename','重命名'],['Fork session','分叉会话'],['Archive session','归档会话'],['Copy Session ID','复制 Session ID']])assert(before.some(x=>names.some(n=>x.text.startsWith(n))&&!x.disabled),'Missing existing action '+names[0])
 await wait(sel(B.id));await menu();await wait(count,1);await wait(sel(B.id));await dismiss()
 await wait(`document.activeElement===document.querySelector(${q(row(A.id)+' button[aria-haspopup="menu"]')})`)
 evidence.checks.push('A/B independent rendered content; right-click A leaves B selected; repeated right-click single menu; Escape focus return')
 for(const [k,code,mods] of [['ContextMenu','ContextMenu',0],['F10','F10',8]]){
  await evaluate(`document.querySelector(${q(row(A.id))}).focus()`);await key(k,code,mods);await wait(count,1);assert.deepEqual(await evaluate(labels),before);await dismiss()
 }
 await mouse(row(A.id)+' button[aria-haspopup="menu"]');await wait(count,1);assert.deepEqual(await evaluate(labels),before)
 // Actual outside click on selected B content, not an arbitrary coordinate near the menu.
 await mouse('[data-message-bubble]');await wait(count,0);await wait(sel(B.id))
 evidence.checks.push('ContextMenu, Shift+F10 and ellipsis reuse identical existing menu; outside click closes')
 await menu();await named(['Copy Session ID','复制 Session ID']);await wait(count,0)
 await wait('navigator.clipboard.readText()',A.id);await wait(sel(B.id))
 evidence.checks.push('Copy Session ID is A, not selected B')
 await menu();await named(['Pin session','置顶会话']);await wait(count,0)
 const pinned=await menu();assert(pinned.some(x=>/^(Unpin session|取消置顶)/.test(x.text)));await named(['Unpin session','取消置顶']);await wait(count,0)
 await menu();await named(['Rename','重命名']);await wait(`!!document.querySelector('[role="dialog"] input')`)
 await mouse('[role="dialog"] input');await key('a','KeyA',2);await c.send('Input.insertText',{text:'SYNTHETIC native renamed A'});await key('Enter');await wait(`document.querySelector('[role="dialog"]')===null`)
 await wait(`document.querySelector(${q(row(A.id))})?.textContent.includes('SYNTHETIC native renamed A')`)
 assert(!(await evaluate(`document.querySelector(${q(row(B.id))}).textContent`)).includes('SYNTHETIC native renamed A'))
 evidence.checks.push('Pin/unpin A');evidence.checks.push('Rename A without changing B')
 const oldIds=await evaluate(`[...document.querySelectorAll('[data-row-key^="session:"]')].map(e=>e.getAttribute('data-row-key'))`)
 await menu();await named(['Fork session','分叉会话']);await wait(count,0)
 const newIds=await wait(`[...document.querySelectorAll('[data-row-key^="session:"]')].map(e=>e.getAttribute('data-row-key')).filter(x=>!${q(oldIds)}.includes(x))`,x=>Array.isArray(x)&&x.length===1)
 const forkId=newIds[0].slice(8);assert(!CASES.some(x=>x.id===forkId));await content({id:forkId,text:A.text})
 evidence.forkId=forkId;evidence.checks.push('Fork from A creates distinct ID with A inherited content, no model submission')
 // Show archived via official view menu before archiving to inspect archived action rules.
 await named(['View options','视图选项'],'button');await named(['All conversations (show archived)','全部对话（显示已归档）']);await content(B)
 await menu();await named(['Archive session','归档会话']);await wait(count,0)
 const archived=await menu();assert(!archived.some(x=>/^(Pin session|Unpin session|置顶会话|取消置顶)/.test(x.text)))
 assert(archived.some(x=>/^(Unarchive session|取消归档|恢复会话)/.test(x.text)));await dismiss();await mouse(row(A.id));await wait(sel(B.id))
 await menu();await named(['Unarchive session','取消归档','恢复会话']);await wait(count,0);await content(A);await content(B)
 evidence.archivedMenu=archived;evidence.checks.push('Archive A: no pin, cannot open; unarchive restores A; B unchanged')
 assert.deepEqual(c.errors,[]);return evidence
}
