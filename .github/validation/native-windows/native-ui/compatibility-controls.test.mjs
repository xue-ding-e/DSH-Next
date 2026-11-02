import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=n=>readFileSync(new URL(n,import.meta.url),'utf8')
const ps=source('installed-ui-smoke.ps1'),probe=source('probe-compatibility.mjs'),welcome=source('probe-welcome.mjs'),native=source('invoke-check-update.ps1')
test('fixed old then new installer digests and exactly one before-GUI seed stage',()=>{
 assert(ps.indexOf("Version='0.2.1-rc.3.20261031.5'")<ps.indexOf("Version='0.2.1-rc.3.20261102.8'"))
 for(const h of ['a3899282c58370f50b68cbd93b6960f67d0fdd57381a76697cb7ee1f09774e9d','9b232ee56cba0b21ab16d7e1c1a007ae31418faf5fa6b44f571e1ee719786947'])assert(ps.includes(h))
 assert(ps.includes('if($stageIndex -eq 0){'));assert(ps.indexOf('seed-installed-sessions.mjs')<ps.indexOf('[OwnedUiJob]::Run'))
})
test('native check-only menu is PID scoped and no download or install action invoked',()=>{
 assert(native.includes('ProcessIdProperty,$OwnerPid'));assert(native.includes('ControlType]::MenuItem'))
 assert(native.includes("'Check for Updates'"));assert(!/Download|Install Now|立即安装|下载/.test(native))
 assert(probe.includes("['download-requested','install-confirmed']"));assert(probe.includes("['downloading','downloaded','ready','installing']"))
})
test('independent D1 evidence precedes optional check-only diagnostic',()=>{
 assert(probe.indexOf("reportPath+'.compatibility.json'")<probe.indexOf('const d2='))
 assert(probe.includes("d2.status='inconclusive'"));assert(probe.includes('networkRequestPaths:\'unknown'))
})
test('D stage budgets reserve overhead inside unchanged hard180 owner',()=>{
 const a=Number(welcome.match(/const until=Date.now\(\)\+(\d+)/)[1])/1000
 const d1=Number(probe.match(/const deadline=Date.now\(\)\+(\d+)/)[1])/1000
 const d2=Number(probe.match(/const end=Date.now\(\)\+(\d+)/)[1])/1000
 assert(30+a+d1+d2+12+30<=180);assert(ps.includes('$install,180)'));assert(source('OwnedUiJob.cs').includes('timeoutSeconds>180'))
})
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {capture} from './retained-state.mjs'
function temp(fn){const d=mkdtempSync(join(tmpdir(),'dsh-retention-'));try{mkdirSync(join(d,'profiles/desktop'),{recursive:true});mkdirSync(join(d,'sessions'));writeFileSync(join(d,'profiles/desktop/package.json'),'{}');writeFileSync(join(d,'profiles/desktop/cordis.patch.yml'),'[]');writeFileSync(join(d,'sessions/synthetic.jsonl'),'synthetic');fn(d)}finally{rmSync(d,{recursive:true,force:true})}}
test('real config/session hashes detect loss without exposing file content',()=>temp(d=>{const a=capture(d);assert.equal(Object.keys(a.files).length,3);writeFileSync(join(d,'sessions/synthetic.jsonl'),'changed');assert.notDeepEqual(capture(d),a);assert(!JSON.stringify(a).includes('synthetic\"'))}))
test('retention rejects missing formal config instead of sentinel-only success',()=>temp(d=>{rmSync(join(d,'profiles/desktop/cordis.patch.yml'));assert.throws(()=>capture(d))}))
test('retention refuses symbolic session link',()=>temp(d=>{symlinkSync(join(d,'profiles'),join(d,'sessions/link'),'junction');assert.throws(()=>capture(d))}))
for(const point of ['root','profiles','desktop'])test('retention refuses '+point+' ancestor symlink before hashing external files',()=>{
 const base=mkdtempSync(join(tmpdir(),'dsh-retention-links-'));try{
  const inside=join(base,'inside'),outside=join(base,'outside');mkdirSync(inside);mkdirSync(join(outside,'desktop'),{recursive:true})
  writeFileSync(join(outside,'package.json'),'{}');writeFileSync(join(outside,'cordis.patch.yml'),'[]');writeFileSync(join(outside,'desktop/package.json'),'{}');writeFileSync(join(outside,'desktop/cordis.patch.yml'),'[]')
  mkdirSync(join(inside,'sessions'));writeFileSync(join(inside,'sessions/x'),'synthetic')
  if(point==='root'){symlinkSync(inside,join(base,'linked'),'junction');assert.throws(()=>capture(join(base,'linked')))}
  else if(point==='profiles'){symlinkSync(outside,join(inside,'profiles'),'junction');assert.throws(()=>capture(inside))}
  else{mkdirSync(join(inside,'profiles'));symlinkSync(outside,join(inside,'profiles/desktop'),'junction');assert.throws(()=>capture(inside))}
 }finally{rmSync(base,{recursive:true,force:true})}
})
