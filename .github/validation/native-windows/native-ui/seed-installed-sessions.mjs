// Run only with the fixed installed Electron executable under its owned Job, BEFORE GUI launch.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {mkdir,readdir,writeFile,realpath} from 'node:fs/promises'
import {CASES,fixture,persistAndVerify} from './synthetic-sessions.mjs'
const [installedRoot,profile,cwd,reportPath]=process.argv.slice(2)
assert.equal(process.platform,'win32');assert(process.versions.electron,'Installed Electron run-as-node capability required')
assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1')
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted')
assert.equal(process.env.GITHUB_REPOSITORY,'xue-ding-e/DSH-Next')
assert.equal(process.env.GITHUB_REF,'refs/heads/validation/released-windows-lifecycle')
assert.equal(resolve(process.execPath),resolve(installedRoot,'DSH Next.exe'))
assert.equal(resolve(profile),resolve(process.env.DSH_NEXT_HOME))
const temp=await realpath(process.env.RUNNER_TEMP)
for(const value of [installedRoot,profile,cwd,reportPath]){
 assert(value);const rel=relative(temp,resolve(value));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Isolated runner temp only')
}
const root=join(profile,'sessions');await mkdir(root,{recursive:true})
assert.deepEqual(await readdir(root),[],'Refuse any existing session store')
const runtime=join(installedRoot,'resources','app.asar','dsh')
const require=createRequire(join(runtime,'package.json'))
const resolved={}
async function shipped(name){const p=require.resolve(name);const rel=relative(runtime,p);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Dependency must be shipped inside fixed ASAR runtime');resolved[name]=rel;return import(pathToFileURL(p).href)}
const [{Context},session,persistence,provider]=await Promise.all([
 shipped('@deepseek-ai/cordis'),shipped('@deepseek-ai/dsh-session'),
 shipped('@deepseek-ai/dsh-session-persistence'),shipped('@deepseek-ai/dsh-session-persistence-jsonl'),
])
const first=new Context(),second=new Context(),sessions=[]
try {
 await first.plugin(provider,{root});await second.plugin(provider,{root})
 for(const row of CASES){
  const value=fixture({version:session.SESSION_FORMAT_VERSION,...row,cwd})
  sessions.push(await persistAndVerify(first.sessionPersistence,second.sessionPersistence,value,e=>e instanceof persistence.SessionAlreadyOwnedError))
 }
}finally{try{await second.fiber.dispose()}finally{await first.fiber.dispose()}}
await writeFile(reportPath,JSON.stringify({source:'published ASAR persistence API; synthetic closed user turns, no model output/provider call',electron:process.versions.electron,node:process.versions.node,resolved,sessions,contextsDisposed:true},null,2),{flag:'wx'})
