// Bootstrap B is independently reviewed and read back before a single B -> W push.
// B adds only validation controls to fixed product P; W changes only workflow trigger.
// No installation capability is enabled by this Phase A gate.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export const PREVIOUS='96b46246bfc60aa0b47e01b7870fa9ebbe8b3e86'
export const PRODUCT='275192ff0c4857c137eeaf96f5320d3034c19d35'
export const BRANCH='refs/heads/validation/released-windows-lifecycle'
export const ROOT='.github/validation/native-windows/'
export const WORKFLOW='.github/workflows/next-native-windows-validation.yml'
export function validateEvent(env,event,bootstrap){
  assert(/^[0-9a-f]{40}$/.test(bootstrap),'unmaterialized bootstrap')
  assert.equal(env.GITHUB_REPOSITORY,'xue-ding-e/DSH-Next')
  assert.equal(env.GITHUB_EVENT_NAME,'push')
  assert.equal(env.GITHUB_REF,BRANCH)
  assert.equal(event.ref,BRANCH)
  assert.equal(event.repository?.full_name,'xue-ding-e/DSH-Next')
  assert.equal(event.before,PREVIOUS)
  assert(/^[0-9a-f]{40}$/.test(env.GITHUB_SHA))
  assert.equal(event.after,env.GITHUB_SHA)
  for(const key of ['created','deleted','forced'])assert.equal(event[key],false)
}
export function validateManifest(manifest){
  const scripts=['OwnedProcessJob.cs','test-owned-process-job.ps1','validate-native-fixture.ps1','released-installer-lifecycle.ps1','read-installed-identity.mjs','read-installed-identity.test.mjs']
  assert.equal(manifest.product,PRODUCT)
  assert.deepEqual(Object.keys(manifest.files).sort(),scripts.sort())
  for(const hash of Object.values(manifest.files))assert(/^[0-9a-f]{64}$/.test(hash))
}
export function run(env,bootstrap){
  validateEvent(env,JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8')),bootstrap)
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
  assert.equal(git('rev-parse','HEAD'),env.GITHUB_SHA)
  assert.equal(git('show','-s','--format=%P','HEAD'),PREVIOUS)
  assert.equal(git('show','-s','--format=%P',PREVIOUS),bootstrap)
  assert.equal(git('show','-s','--format=%P',bootstrap),PRODUCT)
  assert.equal(git('diff','--name-only',bootstrap,PREVIOUS),WORKFLOW)
  assert.deepEqual(git('diff','--name-only',PREVIOUS,'HEAD').split('\n').sort(),[WORKFLOW,ROOT+'source-gate.mjs'].sort())
  const manifest=JSON.parse(git('show',bootstrap+':'+ROOT+'manifest.json'))
  validateManifest(manifest)
  const expected=[WORKFLOW,ROOT+'manifest.json',ROOT+'source-gate.mjs',...Object.keys(manifest.files).map(x=>ROOT+x)].sort()
  assert.deepEqual(git('diff','--name-only',PRODUCT,bootstrap).split('\n').sort(),expected)
  assert.equal(git('diff','--diff-filter=ACMRTUXB','--name-only',PRODUCT,bootstrap),git('diff','--name-only',PRODUCT,bootstrap))
  for(const [name,hash] of Object.entries(manifest.files)){
    const bytes=readFileSync(ROOT+name)
    assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,name)
    assert.equal(git('rev-parse','HEAD:'+ROOT+name),git('rev-parse',bootstrap+':'+ROOT+name))
  }
  assert.equal(git('rev-parse',PREVIOUS+':'+ROOT+'source-gate.mjs'),git('rev-parse',bootstrap+':'+ROOT+'source-gate.mjs'))
  console.log(JSON.stringify({control:env.GITHUB_SHA,bootstrap,product:PRODUCT,scope:'parser/compile/synthetic fixture only; no installation'}))
}
