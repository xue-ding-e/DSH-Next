import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readManifest,validateIdentity} from './read-installed-identity.mjs'
const m=()=>({name:'dsh-next-desktop',productName:'DSH Next',dshDesktopAppId:'io.github.xue-ding-e.dsh-next',version:'0.2.1-rc.3.20261102.8',dshDesktopUpdateChannel:'rc',dshBuildCommit:'275192ff0c4857c137eeaf96f5320d3034c19d35',dshBuildDirty:false,dshNext:{repository:'xue-ding-e/DSH-Next',repositoryId:1437727533}})
const check=r=>validateIdentity(r,m().version,m().dshBuildCommit,'rc')
function fixture(entry={},body=Buffer.from(JSON.stringify(m()))){const json=Buffer.from(JSON.stringify({files:{'package.json':{size:body.length,offset:'0',...entry}}}));const n=Math.ceil((json.length+4)/4)*4;const header=Buffer.alloc(n+4);header.writeUInt32LE(n,0);header.writeUInt32LE(json.length,4);json.copy(header,8);const prefix=Buffer.alloc(8);prefix.writeUInt32LE(4);prefix.writeUInt32LE(header.length,4);return Buffer.concat([prefix,header,body])}
function withFile(bytes,fn){const r=mkdtempSync(join(tmpdir(),'asar-identity-'));try{const f=join(r,'app.asar');writeFileSync(f,bytes);fn(f)}finally{rmSync(r,{recursive:true,force:true})}}
test('reads bounded packed root manifest and validates actual identity',()=>withFile(fixture(),f=>assert.equal(check(readManifest(f)).channel,'rc')))
for(const [field,value] of Object.entries({version:'0.1',dshDesktopUpdateChannel:'nightly',dshBuildCommit:'0'.repeat(40),dshBuildDirty:true,name:'official',productName:'Other',dshDesktopAppId:'other'}))test('reject wrong '+field,()=>assert.throws(()=>check({manifest:{...m(),[field]:value}})))
for(const entry of [{link:'outside'},{unpacked:true},{offset:'-1'},{offset:'90071992547409999'},{size:2**25},{integrity:{algorithm:'SHA256',hash:'wrong'}}])test('reject malformed/unsafe manifest entry '+JSON.stringify(entry),()=>withFile(fixture(entry),f=>assert.throws(()=>readManifest(f))))
test('reject truncated archive',()=>withFile(fixture().subarray(0,17),f=>assert.throws(()=>readManifest(f))))
test('reject enormous header before allocation',()=>{const b=fixture();b.writeUInt32LE(2**30,4);withFile(b,f=>assert.throws(()=>readManifest(f)))})

const cli=fileURLToPath(new URL('./read-installed-identity.mjs',import.meta.url))
function runCli(args){return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:5000})}
test('real CLI emits exactly one validated identity JSON line',()=>withFile(fixture(),f=>{
  const r=runCli([f,m().version,m().dshBuildCommit,'rc']);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'')
  const lines=r.stdout.trim().split('\n');assert.equal(lines.length,1)
  const v=JSON.parse(lines[0]);assert.equal(v.version,m().version);assert.equal(v.sourceSha,m().dshBuildCommit);assert.equal(v.channel,'rc')
}))
test('real CLI rejects missing arguments without success JSON',()=>{const r=runCli([]);assert.notEqual(r.status,0);assert.equal(r.stdout,'')})
test('real CLI rejects wrong expected source without success JSON',()=>withFile(fixture(),f=>{const r=runCli([f,m().version,'0'.repeat(40),'rc']);assert.notEqual(r.status,0);assert.equal(r.stdout,'')}))
test('real CLI rejects malformed archive without success JSON',()=>withFile(Buffer.from('broken'),f=>{const r=runCli([f,m().version,m().dshBuildCommit,'rc']);assert.notEqual(r.status,0);assert.equal(r.stdout,'')}))
