// Synthetic closed turns only. No model/provider invocation or fabricated runtime response.
import assert from 'node:assert/strict'
export const CASES = Object.freeze([
 {id:'native-menu-a-20261102',text:'SYNTHETIC NATIVE MENU A: no provider request was made.'},
 {id:'native-menu-b-20261102',text:'SYNTHETIC NATIVE MENU B: independent selected row.'},
])
export function fixture({version,id,text,cwd}) {
 assert(CASES.some(x=>x.id===id&&x.text===text),'Only the fixed synthetic A/B fixtures are permitted')
 assert(Number.isSafeInteger(version)&&version>=0)
 assert(typeof cwd==='string'&&cwd.length>0)
 const meta={version,id,createdAt:1793646000000,cwd,isSeeded:false,delegationDepth:0}
 const rows=[
  {type:'turn/start',data:{turn:1}},
  {type:'step/start',data:{turn:1,step:1}},
  {type:'user/message',surfaceOp:'append',data:{id:id+'-question',role:'user',source:{kind:'user'},content:[{type:'text',text}]}},
  {type:'step/end',data:{turn:1,step:1}},
  {type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
 ]
 return {meta,events:rows.map((x,seq)=>({...x,seq,time:meta.createdAt+seq+1}))}
}
export async function persistAndVerify(first,second,value,isOwnedError) {
 const {meta,events}=value
 let writer
 try {
  writer=await first.create(meta)
  await writer.append(events);await writer.flush()
  let rival
  try {rival=await second.open(meta.id,'write');throw Error('Second writer unexpectedly admitted')}
  catch(error){if(!isOwnedError(error))throw error}
  finally{await rival?.close()}
 } finally {await writer?.close()}
 // Reopening from the formerly refused provider proves release, not file-name heuristics.
 const released=await second.open(meta.id,'write')
 try {assert.equal(released.id,meta.id);assert.deepEqual(released.header,meta);assert.deepEqual((await released.read()).events,events)}finally{await released.close()}
 const reader=await first.open(meta.id,'read')
 try {assert.equal(reader.id,meta.id);assert.deepEqual(reader.header,meta);assert.deepEqual((await reader.read()).events,events)}finally{await reader.close()}
 return {id:meta.id,text:events[2].data.content[0].text,eventCount:events.length,closedTurn:true,writerExcluded:true,writerReleased:true,readbackExact:true}
}
