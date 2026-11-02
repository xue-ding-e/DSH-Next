// Hash only the two real profile documents and bounded synthetic session-store files; never upload contents.
import assert from 'node:assert/strict'
import {lstatSync,readdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
export function capture(profile){
 const root=resolve(profile)
 const rootStat=lstatSync(root);assert(rootStat.isDirectory()&&!rootStat.isSymbolicLink(),'Synthetic root must be a real directory')
 assert.equal(relative(root,realpathSync(root)),'','Root or ancestor resolves through a link')
 function directory(name){
  let current=root
  for(const part of name.split(/[\\/]/).filter(Boolean)){
   assert(part!=='.'&&part!=='..');current=join(current,part)
   const s=lstatSync(current);assert(s.isDirectory()&&!s.isSymbolicLink(),'Linked directory refused')
   assert.equal(relative(current,realpathSync(current)),'','Directory resolves through a link')
   const rel=relative(root,realpathSync(current));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel))
  }
 }
 const files={};let bytes=0
 function add(name){const p=join(profile,name),s=lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink());bytes+=s.size;assert(bytes<=10*1024*1024);assert(Object.keys(files).length<256);files[name]=createHash('sha256').update(readFileSync(p)).digest('hex')}
 directory('profiles/desktop')
 for(const n of ['profiles/desktop/package.json','profiles/desktop/cordis.patch.yml'])add(n)
 function scan(name,depth=0){assert(depth<12);directory(name);const dir=join(root,name);for(const n of readdirSync(dir)){const next=join(name,n),v=lstatSync(join(profile,next));assert(!v.isSymbolicLink());if(v.isDirectory())scan(next,depth+1);else add(next)}}
 scan('sessions');assert(Object.keys(files).length>2,'Expected synthetic sessions')
 return {files,totalBytes:bytes,scope:'two profile documents and bounded owned synthetic sessions only'}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.platform,'win32')
 const [profile,out,expected]=process.argv.slice(2);assert.equal(resolve(profile),resolve(process.env.DSH_NEXT_HOME))
 for(const p of [profile,out]){const rel=relative(resolve(process.env.RUNNER_TEMP),resolve(p));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel))}
 const result=capture(profile);if(expected)assert.deepEqual(result,JSON.parse(readFileSync(expected,'utf8')),'Synthetic retained configuration/session data changed during uninstall')
 writeFileSync(out,JSON.stringify(result,null,2),{flag:'wx'})
}
