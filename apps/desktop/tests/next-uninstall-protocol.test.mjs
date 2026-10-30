// Bounded synthetic NSIS instruction model, not a native installer test.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../installer/uninstall.nsh',import.meta.url),'utf8')
const body=source.split('!macro NextRemoveOwnedProtocol View\n')[1]?.split('!macroend')[0]
const expected='"C:\\Synthetic\\DSH Next.exe" "%1"'
function run(command) {
 let value,match=false,deleted=false,view='original',previous
 const key='Software\\Classes\\dsh-next'
 for(const line of body.trim().split('\n').map(s=>s.trim())) {
  if(line==='SetRegView ${View}') {previous=view;view='selected'}
  else if(line===`ReadRegStr $0 HKCU "${key}\\shell\\open\\command" ""`) value=command??''
  else if(line===`StrCpy $1 '$\\"$INSTDIR\\DSH Next.exe$\\" $\\"%1$\\"'`) {}
  else if(line==='StrCmpS $0 $1 0 +2') match=value===expected
  else if(line===`DeleteRegKey HKCU "${key}"`) deleted=match
  else if(line==='SetRegView lastused') view=previous
  else assert.fail('unmodeled NSIS instruction')
 }
 assert.equal(view,'original');return deleted
}
test('owned handler removed; absent, foreign, changed arguments and case preserved',()=>{
 assert(run(expected))
 for(const command of [undefined,'',expected.replace('Synthetic','Another'),expected+' --foreign',expected.toLowerCase(),'"C:\\Synthetic\\DeepSeek Harness.exe" "%1"'])assert.equal(run(command),false)
 assert.equal(run(undefined),false) // Already absent: repeat is a no-op.
})
test('cleanup uses fixed HKCU views and only the Next package path',()=>{
 assert(body)
 const fn=source.split('Function un.RemoveOwnedNextProtocol\n')[1].split('FunctionEnd')[0]
 assert.equal((fn.match(/!insertmacro NextRemoveOwnedProtocol 32/g)||[]).length,1)
 assert.equal((fn.match(/!insertmacro NextRemoveOwnedProtocol 64/g)||[]).length,1)
 assert.match(fn,/Push \$0\s+Push \$1[\s\S]*Pop \$1\s+Pop \$0/)
 const clean=source.split('Function un.CleanData\n')[1]
 assert.match(clean,/!if "\$\{APP_PACKAGE_NAME\}" == "dsh-next-desktop"\s+Call un.RemoveOwnedNextProtocol/)
 assert.equal((source.match(/Call un.RemoveOwnedNextProtocol/g)||[]).length,1)
 assert(!body.includes('HKLM'));assert(!body.includes('Software\\Classes\\dsh"'))
})

test('absence cannot leak ReadRegStr errors into the caller',()=>{
 const fn=source.split('Function un.RemoveOwnedNextProtocol\n')[1].split('FunctionEnd')[0]
 assert.match(fn,/Push \$2\s+StrCpy \$2 0\s+\$\{If\} \$\{Errors\}\s+StrCpy \$2 1/)
 assert.match(fn,/\$\{If\} \$2 == 1\s+SetErrors\s+\$\{Else\}\s+ClearErrors\s+\$\{EndIf\}\s+Pop \$2/)
})
