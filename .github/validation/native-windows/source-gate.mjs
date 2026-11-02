// C1: exact reviewed C0 descendant; fixed product P and all earlier controls preserved.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export const PREVIOUS='c2cd1fcc322c04224a952cf736a71ea419e0c3ef'
export const PHASE_C0='6bfd53a8503638f227c453c2cb19271a7eda4fae'
export const LIFECYCLE='807bc292a77707e4fc0f15030cf61808ff9577a8'
export const PREVIOUS_TREE='72a85f77f5852987bae7b3b7708d9ac1e3e710e9'
export const PHASE_A='525161dc8eeec6f02217d99d54bb6e48ac2d40f4'
export const FIRST_CONTROL='96b46246bfc60aa0b47e01b7870fa9ebbe8b3e86'
export const UI_MANIFEST_SHA='2fdda71599c1a03573981a0d1e4ef11f21c07f0682b10d269a4f804e92955009'
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
  assert.equal(git('rev-parse',PREVIOUS+'^{tree}'),PREVIOUS_TREE)
  assert.equal(git('show','-s','--format=%P',PREVIOUS),PHASE_C0)
  assert.equal(git('show','-s','--format=%P',PHASE_C0),LIFECYCLE)
  assert.equal(git('show','-s','--format=%P',LIFECYCLE),PHASE_A)
  assert.equal(git('show','-s','--format=%P',PHASE_A),FIRST_CONTROL)
  assert.equal(git('show','-s','--format=%P',FIRST_CONTROL),bootstrap)
  assert.equal(git('show','-s','--format=%P',bootstrap),PRODUCT)
  assert.equal(git('diff','--name-only',bootstrap,FIRST_CONTROL),WORKFLOW)
  for(const [a,b] of [[FIRST_CONTROL,PHASE_A],[PHASE_A,LIFECYCLE]]) assert.deepEqual(git('diff','--name-only',a,b).split('\n').sort(),[WORKFLOW,ROOT+'source-gate.mjs'].sort())
  const uiBytes=readFileSync(ROOT+'native-ui/ui-manifest.json')
  assert.equal(createHash('sha256').update(uiBytes).digest('hex'),UI_MANIFEST_SHA)
  const ui=JSON.parse(uiBytes)
  for(const [name,hash] of Object.entries(ui)) {
    assert(/^[A-Za-z0-9.-]+$/.test(name)&&/^[0-9a-f]{64}$/.test(hash))
    assert.equal(createHash('sha256').update(readFileSync(ROOT+'native-ui/'+name)).digest('hex'),hash)
  }
  assert.deepEqual(Object.keys(ui).sort(),["OwnedUiJob.cs", "attest-listener.ps1", "cdp-endpoint.mjs", "cdp-endpoint.test.mjs", "compatibility-controls.test.mjs", "installed-ui-smoke.ps1", "invoke-check-update.ps1", "listener-policy.ps1", "probe-compatibility.mjs", "probe-session-menus.mjs", "probe-welcome.mjs", "retained-state.mjs", "seed-installed-sessions.mjs", "synthetic-sessions.mjs", "synthetic-sessions.test.mjs", "test-listener-policy.ps1", "test-owned-ui-job.ps1", "validate-ui-fixture.ps1"].sort())
  const added=['probe-compatibility.mjs','invoke-check-update.ps1','compatibility-controls.test.mjs','retained-state.mjs'].map(n=>ROOT+'native-ui/'+n)
  const modified=['ui-manifest.json','probe-welcome.mjs','installed-ui-smoke.ps1','validate-ui-fixture.ps1'].map(n=>ROOT+'native-ui/'+n)
  assert.deepEqual(git('diff','--name-only',PREVIOUS,'HEAD').split('\n').sort(),[WORKFLOW,ROOT+'source-gate.mjs',...added,...modified].sort())
  assert.deepEqual(git('diff','--diff-filter=A','--name-only',PREVIOUS,'HEAD').split('\n').sort(),added.sort())
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
  assert.equal(git('rev-parse',FIRST_CONTROL+':'+ROOT+'source-gate.mjs'),git('rev-parse',bootstrap+':'+ROOT+'source-gate.mjs'))
  console.log(JSON.stringify({control:env.GITHUB_SHA,bootstrap,product:PRODUCT,scope:'Phase D old-to-new configuration semantic qualification and independent public update check only; no updater install'}))
}
