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
 assert(30+a+d1+d2+12+5+30<=180);assert(ps.includes('$install,180)'));assert(source('OwnedUiJob.cs').includes('timeoutSeconds>180'))
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

import {runInNewContext} from 'node:vm'
import {openSessionMenu} from './probe-compatibility.mjs'
function contextFixture({missing=false,ignoreHover=false}={}){
 const events=[],queries=[];let menu=false
 const row={scrollIntoView(){},getBoundingClientRect(){return {x:10,y:20,width:200,height:30}}}
 const document={querySelector(s){queries.push(s);assert.equal(s,'[data-row-key="session:native-menu-a-20261102"]');return missing?null:row},querySelectorAll(){return menu?[{}]:[]}}
 const c={async send(method,p){assert.equal(method,'Input.dispatchMouseEvent');events.push(p);if(p.type==='mouseReleased'&&p.button==='right')menu=true}}
 const wait=async(expr,p=x=>x===true)=>{const v=runInNewContext(expr,{document});assert(p(v),'expected real visible row and menu');return v}
 return {c,wait,events,queries}
}
test('exact A context gesture opens existing menu without hidden button or hover dependency',async()=>{
 const f=contextFixture({ignoreHover:true});await openSessionMenu(f.c,f.wait,'native-menu-a-20261102')
 assert.deepEqual(f.events.map(e=>e.type),['mouseMoved','mousePressed','mouseReleased'])
 for(const e of f.events.slice(1)){assert.equal(e.button,'right');assert.equal(e.x,110);assert.equal(e.y,35)}
 assert.equal(f.queries.length,1)
})
test('missing synthetic row fails before pointer action',async()=>{
 const f=contextFixture({missing:true});await assert.rejects(openSessionMenu(f.c,f.wait,'native-menu-a-20261102'),/real visible row/);assert.equal(f.events.length,0)
})
test('foreign session ID rejected before DOM lookup or pointer operation',async()=>{
 const f=contextFixture();await assert.rejects(openSessionMenu(f.c,f.wait,'real-session'),/Only synthetic/)
 assert.equal(f.queries.length,0);assert.equal(f.events.length,0)
})
test('compatibility uses reviewed context helper, not a direct hidden-button click',()=>assert(probe.includes('const menu=id=>openSessionMenu(c,wait,id)')))

import {independentCheck,diagnosticExpression,captureDiagnostic} from './probe-compatibility.mjs'
test('D2 executes after D1 failure and original error cannot become green',async()=>{
 const original=Error('original D1');let called=0
 await assert.rejects(independentCheck(original,async()=>{called++;return {status:'observed'}}),e=>e===original)
 assert.equal(called,1)
 await assert.rejects(independentCheck(original,async()=>{throw Error('independent diagnostic')}),e=>e===original)
 assert.deepEqual(await independentCheck(null,async()=>({status:'inconclusive'})),{status:'inconclusive'})
})
test('D2 input gets independent 5s budget after expired D1 and remains check-only',()=>{
 assert(probe.includes("querySelector('button')\",Date.now()+5000)"));assert(probe.includes('until=deadline'))
 assert(probe.indexOf('captureDiagnostic(c,reportPath,stage,error,signal)')<probe.indexOf('return independentCheck(d1Error'))
})
test('bounded snapshot has visibility, hit testing, structure and ancestor evidence, no text dump',()=>{
 const expr=diagnosticExpression();for(const key of ['rowActions','ancestors','centerHit','rowHovered','buttonExists','children','safeOrigin'])assert(expr.includes(key))
 assert(!/textContent|innerHTML|outerHTML|cookie|fetch/.test(expr))
})
test('unsafe renderer cannot produce screenshot, original error retained',async()=>{
 const d=mkdtempSync(join(tmpdir(),'dsh-diagnostic-'));try{
 let captured=false;const c={send:async method=>{if(method==='Page.captureScreenshot'){captured=true;throw Error('must not capture')}return {result:{value:{safeOrigin:false}}}}}
 await captureDiagnostic(c,join(d,'report'),'old',Error('original'))
 assert.equal(captured,false);const report=JSON.parse(readFileSync(join(d,'report.diagnostic.json')));assert.equal(report.originalError,'original');assert(report.diagnosticError)
 }finally{rmSync(d,{recursive:true,force:true})}
})
test('diagnostic expression actually evaluates absent/hidden buttons and foreign hit safely',()=>{
 let hidden=false
 const row={tagName:'DIV',parentElement:null,getAttribute:()=>null,querySelector:()=>hidden?button:null,getBoundingClientRect:()=>({x:1,y:2,width:100,height:30}),matches:()=>true,contains:()=>false,children:[]}
 const button={tagName:'BUTTON',parentElement:row,disabled:false,getAttribute:()=>null,getBoundingClientRect:()=>({x:0,y:0,width:0,height:0})}
 const foreign={tagName:'DIV',getAttribute:()=>null,getBoundingClientRect:()=>({x:0,y:0,width:20,height:20}),closest:()=>({getAttribute:()=> 'session:other-synthetic'})}
 const env={location:{protocol:'dsh-app:',hostname:'app'},innerWidth:1200,innerHeight:800,document:{querySelector:()=>row,querySelectorAll:()=>[],elementFromPoint:()=>foreign},getComputedStyle:()=>({display:'none',visibility:'visible',pointerEvents:'auto'})}
 const expr=diagnosticExpression(),a=runInNewContext(expr,env);assert.equal(a.safeOrigin,true);assert.equal(a.rows[0].buttonExists,false);assert.equal(a.rows[0].centerHitSyntheticId,null)
 hidden=true;const b=runInNewContext(expr,env);assert.equal(b.rows[0].buttonExists,true);assert.equal(b.rows[0].button.rect.width,0);assert.equal(b.rows[0].rowActions.display,'none');assert.equal(b.rows[0].centerHitsRow,false)
})

import {isolateDiagnostic} from './probe-compatibility.mjs'
for(const mode of ['absent-directory','parent-is-file'])test('diagnostic '+mode+' cannot replace D1 or skip D2',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-diagnostic-write-'));try{
  const parent=join(dir,'not-directory');if(mode==='parent-is-file')writeFileSync(parent,'synthetic')
  const c={send:async()=>({result:{value:{safeOrigin:false}}})},original=Error('original D1');let checked=false
  const diagnostic=await isolateDiagnostic(signal=>captureDiagnostic(c,join(parent,'report'),'old',original,signal))
  assert.equal(diagnostic.status,'failed');assert(diagnostic.error.length<=500)
  await assert.rejects(independentCheck(original,async()=>{checked=true;return {diagnostic,status:'inconclusive'}}),e=>e===original)
  assert.equal(checked,true)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('hanging diagnostic is bounded, aborted and cannot suppress D2',async()=>{
 let signal,checked=false;const original=Error('original'),start=Date.now()
 const diagnostic=await isolateDiagnostic(s=>{signal=s;return new Promise(()=>{})},10)
 assert.equal(diagnostic.status,'failed');assert.match(diagnostic.error,/deadline/);assert.equal(signal.aborted,true);assert(Date.now()-start<1000)
 await assert.rejects(independentCheck(original,async()=>{checked=true}),e=>e===original);assert.equal(checked,true)
})
test('late CDP completion after diagnostic abort cannot write evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-diagnostic-late-'));try{
  let resolve;const response=new Promise(r=>{resolve=r}),c={send:()=>response},path=join(dir,'report')
  const result=await isolateDiagnostic(signal=>captureDiagnostic(c,path,'old',Error('original'),signal),10)
  assert.equal(result.status,'failed');resolve({result:{value:{safeOrigin:false}}});await new Promise(r=>setTimeout(r,10))
  assert.throws(()=>readFileSync(path+'.diagnostic.json'),/ENOENT/)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('production D1 catch isolates complete diagnostic call before independent D2',()=>{
 assert(probe.includes('diagnosticStatus=await isolateDiagnostic(signal=>captureDiagnostic(c,reportPath,stage,error,signal))'))
 assert(probe.includes('priorD1Diagnostic:diagnosticStatus'))
})

test('context gesture cannot pass when renderer never opens a menu',async()=>{
 const f=contextFixture();const c={send:async()=>{}};await assert.rejects(openSessionMenu(c,f.wait,'native-menu-a-20261102'),/real visible row and menu/)
})
test('native diagnostics stay exact owned PID, read-only focus and bounded report destination',()=>{
 for(const marker of ['GetForegroundWindow','GetWindowThreadProcessId','ProcessId -ne $OwnerPid','TreeScope]::Children','-ge 128','-ge 4','RUNNER_TEMP','GetFullPath'])assert(native.includes(marker))
 assert(!/SetForegroundWindow|SetFocus\(|ShowWindow|SendKeys|mouse_event/.test(native));assert(probe.includes("'-ReportPath',reportPath+'.native-menu.json'"))
})
