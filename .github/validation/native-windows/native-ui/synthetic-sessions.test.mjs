import test from 'node:test'
import assert from 'node:assert/strict'
import {CASES,fixture,persistAndVerify} from './synthetic-sessions.mjs'
const value=fixture({version:4,...CASES[0],cwd:'C:\\synthetic'})
test('exact fixed A/B synthetic identities, no provider/model output',()=>{
 assert.notEqual(CASES[0].id,CASES[1].id)
 for(const row of CASES){const f=fixture({version:4,...row,cwd:'C:\\synthetic'});assert.deepEqual(f.events.map(x=>x.seq),[0,1,2,3,4]);assert.equal(f.events.at(-1).type,'turn/end');assert.equal(f.events[2].data.content[0].text,row.text);assert(!JSON.stringify(f).includes('assistant/message'))}
})
test('rejects arbitrary IDs or content',()=>{assert.throws(()=>fixture({version:4,id:'real',text:'private',cwd:'x'}));assert.throws(()=>fixture({version:4,...CASES[0],text:'other',cwd:'x'}))})
function mock({failAppend=false,allowRival=false,corrupt=false}={}){
 let held=false,closed=0,flush=0,reads=0
 const writer={append:async()=>{held=true;if(failAppend)throw Error('append failure')},flush:async()=>{flush++},close:async()=>{held=false;closed++}}
 const handle=()=>({id:value.meta.id,header:value.meta,read:async()=>{reads++;return {events:corrupt?[]:value.events}},close:async()=>{closed++}})
 const first={create:async()=>writer,open:async()=>handle()}
 const second={open:async()=>{if(held&&!allowRival){const e=Error('owned');e.name='SessionAlreadyOwnedError';throw e}return handle()}}
 return {first,second,state:()=>({held,closed,flush,reads})}
}
const isOwned=e=>e.name==='SessionAlreadyOwnedError'
test('flush, exclusion, release and two exact readbacks',async()=>{const m=mock();const r=await persistAndVerify(m.first,m.second,value,isOwned);assert(r.writerExcluded&&r.writerReleased);assert.deepEqual(m.state(),{held:false,closed:3,flush:1,reads:2})})
test('append failure still closes holder',async()=>{const m=mock({failAppend:true});await assert.rejects(persistAndVerify(m.first,m.second,value,isOwned),/append failure/);assert.equal(m.state().held,false);assert.equal(m.state().closed,1)})
test('unexpected rival success fails and closes both',async()=>{const m=mock({allowRival:true});await assert.rejects(persistAndVerify(m.first,m.second,value,isOwned),/unexpectedly admitted/);assert.equal(m.state().held,false);assert.equal(m.state().closed,2)})
test('corrupt readback fails with released handle closed',async()=>{const m=mock({corrupt:true});await assert.rejects(persistAndVerify(m.first,m.second,value,isOwned));assert.equal(m.state().closed,2)})
test('unrelated lock errors never counted as exclusion',async()=>{const m=mock();m.second.open=async()=>{throw Error('IO failure')};await assert.rejects(persistAndVerify(m.first,m.second,value,isOwned),/IO failure/);assert.equal(m.state().held,false)})

// Cross-file regression: never discover a deterministic C# argument refusal on CI.
import {readFileSync} from 'node:fs'
function timeoutContract(ps,cs,welcome,menu,attest){
 const cap=Number(cs.match(/timeoutSeconds>\s*(\d+)/)?.[1]);assert(Number.isInteger(cap)&&cap>0)
 const call=Number(ps.match(/\[OwnedUiJob\]::Run\([^\n]+,\$install,(\d+)\)/)?.[1]);assert(Number.isInteger(call)&&call>0&&call<=cap,'OwnedUiJob caller exceeds proven helper cap')
 const welcomeMs=Number(welcome.match(/const until=Date\.now\(\)\+(\d+)/)?.[1])
 const menuMs=Number(menu.match(/const end=Date\.now\(\)\+(\d+)/)?.[1])
 const listenerSec=Number(attest.match(/UtcNow\.AddSeconds\((\d+)\)/)?.[1])
 assert(welcomeMs>0&&menuMs>0&&listenerSec>0)
 assert(listenerSec+(welcomeMs+menuMs)/1000+30<=call,'Nominal stage budget must leave 30 seconds overhead under hard owner cap')
 return {cap,call}
}
const source=name=>readFileSync(new URL(name,import.meta.url),'utf8')
const timeoutSources=()=>['installed-ui-smoke.ps1','OwnedUiJob.cs','probe-welcome.mjs','probe-session-menus.mjs','attest-listener.ps1'].map(source)
test('actual wrapper timeout and stage budgets fit unchanged owned helper',()=>assert.deepEqual(timeoutContract(...timeoutSources()),{cap:180,call:180}))
test('regression rejects former 240s call before any Windows launch',()=>{const s=timeoutSources();s[0]=s[0].replace('$install,180)','$install,240)');assert.throws(()=>timeoutContract(...s),/exceeds/)} )
test('regression rejects stage budget exceeding hard owner deadline',()=>{const s=timeoutSources();s[3]=s[3].replace('Date.now()+75000','Date.now()+120000');assert.throws(()=>timeoutContract(...s),/budget/)} )
