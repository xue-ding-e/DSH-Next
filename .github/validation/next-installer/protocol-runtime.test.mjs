import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runtimeEnvironment, PROFILE_PATCH, inspectorEndpoint, verifyProtocolSnapshots, verifyRuntimeIdentity} from './protocol-policy.mjs'
import {Inspector, IDENTITY_EXPRESSION, QUIT_EXPRESSION, loadedScriptMatches} from './protocol-runtime.mjs'
const exe='C:\\owned\\Installed Next\\DSH Next.exe', root='C:\\owned\\runtime-new'
const env=runtimeEnvironment('C:\\Windows',root)
test('environment is constructed not inherited, all homes synthetic',()=>{
 for(const forbidden of ['GITHUB_TOKEN','GH_TOKEN','NODE_OPTIONS','ELECTRON_RUN_AS_NODE','OPENAI_API_KEY','DSH_PROFILE','HTTP_PROXY'])assert(!(forbidden in env))
 assert.equal(env.DSH_TELEMETRY_DISABLED,'1');assert(env.DSH_NEXT_HOME.startsWith(root));assert(env.APPDATA.startsWith(root))
 assert.equal(PROFILE_PATCH.match(/disabled: true/g).length,3)
 for(const name of ['session-telemetry-otel','desktop-product-telemetry','product-analytics'])assert(PROFILE_PATCH.includes('- id: '+name+'\n  disabled: true'))
})
test('only literal loopback endpoint with explicit valid port',()=>{
 assert.equal(inspectorEndpoint('Debugger listening on ws://127.0.0.1:12345/12345678-1234-1234-1234-123456789abc'),'ws://127.0.0.1:12345/12345678-1234-1234-1234-123456789abc')
 for(const host of ['0.0.0.0','localhost','evil.example','user@127.0.0.1'])assert.throws(()=>inspectorEndpoint(`Debugger listening on ws://${host}:12345/12345678-1234-1234-1234-123456789abc`))
 assert.throws(()=>inspectorEndpoint('Debugger listening on ws://127.0.0.1:0/12345678-1234-1234-1234-123456789abc'))
})
test('loaded script matching handles percent-encoded spaces but rejects another file',()=>{
 assert(loadedScriptMatches('file:///C:/owned/Installed%20Next/resources/app.asar/lib/main.js','C:\\owned\\Installed Next\\resources\\app.asar\\lib\\main.js'))
 assert(!loadedScriptMatches('http://evil/main.js','C:\\main.js'));assert(!loadedScriptMatches('file:///C:/other.js','C:\\main.js'))
})
const views=()=>['CurrentUser','LocalMachine'].flatMap(hive=>['Registry32','Registry64'].map(view=>({hive,view,exists:false,urlProtocolPresent:false,command:null})))
const registered=()=>views().map(e=>e.hive==='CurrentUser'?{...e,exists:true,urlProtocolPresent:true,command:`"${exe}" "%1"`}:e)
test('all-view registry gate accepts real owned handler only',()=>{
 verifyProtocolSnapshots(views(),registered(),exe)
 for(const field of ['command','urlProtocolPresent']){const bad=registered();bad[0][field]=null;assert.throws(()=>verifyProtocolSnapshots(views(),bad,exe))}
 const foreign=registered();foreign[0].command='foreign';assert.throws(()=>verifyProtocolSnapshots(foreign,registered(),exe))
 const machine=registered();machine[2].exists=true;assert.throws(()=>verifyProtocolSnapshots(views(),machine,exe))
 assert.throws(()=>verifyProtocolSnapshots(views(),[...registered().slice(1),registered()[1]],exe))
})
const identity=()=>({isPackaged:true,execPath:exe,appPath:'C:\\owned\\Installed Next\\resources\\app.asar',version:'test',electron:'44.7.0',ready:true,defaultProtocol:true,userData:root+'\\userData',logs:root+'\\logs',home:root+'\\home',cwd:root,nextHome:env.DSH_NEXT_HOME,dshHome:env.DSH_NEXT_HOME,telemetryDisabled:'1',runAsNode:false,windows:[{url:'file:///C:/owned/app.asar/renderer/welcome.html'}]})
test('runtime identity rejects wrong binary/profile/unregistered/no welcome',()=>{
 verifyRuntimeIdentity(identity(),{exe,root,version:'test'})
 for(const [key,value] of Object.entries({execPath:'C:\\other.exe',isPackaged:false,defaultProtocol:false,userData:'C:\\Users\\runneradmin',runAsNode:true,windows:[]}))assert.throws(()=>verifyRuntimeIdentity({...identity(),[key]:value},{exe,root,version:'test'}))
})
test('expressions compile and never replace original app registration',()=>{
 new Function('return '+IDENTITY_EXPRESSION);new Function('return '+QUIT_EXPRESSION)
 assert(!QUIT_EXPRESSION.includes('setAsDefault'));assert(QUIT_EXPRESSION.includes('app.quit()'))
 assert(!IDENTITY_EXPRESSION.includes("setAsDefaultProtocolClient('"))
})
class Socket extends EventTarget {sent=[];send(s){this.sent.push(JSON.parse(s))}reply(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}))}}
test('inspector response error and premature close fail; only requested identity/quit evaluated',async()=>{
 const s=new Socket(),i=new Inspector(s);s.reply({method:'Runtime.executionContextCreated',params:{context:{id:7,auxData:{isDefault:true}}}});const p=i.read('identity');s.reply({id:1,result:{result:{value:{pid:12}}}});assert.deepEqual(await p,{pid:12})
 const q=i.read('bad');s.reply({id:2,result:{exceptionDetails:{text:'bad'}}});await assert.rejects(q)
 const r=i.send('Debugger.getScriptSource');s.dispatchEvent(new Event('close'));await assert.rejects(r)
})
test('runtime has no PID termination, shell launch, Playwright, or registry mutation',()=>{
 const source=readFileSync(new URL('./protocol-runtime.mjs',import.meta.url),'utf8')
 assert(!/process\.kill|\.kill\(|taskkill|shell:\s*true|playwright/.test(source));assert(source.includes('shell:false'))
 const reg=readFileSync(new URL('./registry-snapshot.ps1',import.meta.url),'utf8');assert(!/CreateSubKey|SetValue|DeleteSubKey/.test(reg))
 const wrapper=readFileSync(new URL('./invoke-protocol-runtime.ps1',import.meta.url),'utf8');assert(wrapper.includes('-TimeoutSeconds 150'));assert(wrapper.includes('naturalQuiescence'));assert(wrapper.includes('quiescenceConfirmed'))
})

test('only one live default execution context may receive identity or quit',async()=>{
 const s=new Socket(),i=new Inspector(s)
 await assert.rejects(i.read('identity'))
 s.reply({method:'Runtime.executionContextCreated',params:{context:{id:4,auxData:{isDefault:false}}}})
 await assert.rejects(i.read('identity'))
 s.reply({method:'Runtime.executionContextCreated',params:{context:{id:7,auxData:{isDefault:true}}}})
 const p=i.read('identity');assert.equal(s.sent[0].params.contextId,7);s.reply({id:1,result:{result:{value:true}}});await p
 s.reply({method:'Runtime.executionContextDestroyed',params:{executionContextId:7}})
 await assert.rejects(i.read('quit'))
 const j=new Inspector(new Socket());j.socket.reply({method:'Runtime.executionContextCreated',params:{context:{id:1,auxData:{isDefault:true}}}});j.socket.reply({method:'Runtime.executionContextCreated',params:{context:{id:2,auxData:{isDefault:true}}}});await assert.rejects(j.read('quit'))
})
test('outer Node startup has explicit pinned tool and sanitized environment',()=>{
 const wrapper=readFileSync(new URL('./invoke-protocol-runtime.ps1',import.meta.url),'utf8')
 assert(!wrapper.includes('Get-Command node'));assert(wrapper.includes('$ExpectedNodeSha256'))
 assert(wrapper.includes('$result = Invoke-NextCleanEnvironment -Safe $safe -Action'));assert(wrapper.includes("SetEnvironmentVariable($key,$null,'Process')"))
 assert(wrapper.includes('finally {'));assert(wrapper.includes("SetEnvironmentVariable($key,$saved[$key],'Process')"))
})
