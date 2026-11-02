// Fail-closed connection policy. A separate Windows owner must attest the listener PID
// belongs to its Job and is bound exclusively to loopback before calling this module.
import assert from 'node:assert/strict'
export function loopbackEndpoint(value,expectedPort,{websocket=false}={}){
  const u=new URL(value)
  assert(Number.isInteger(expectedPort)&&expectedPort>1024&&expectedPort<=65535)
  assert.equal(u.protocol,websocket?'ws:':'http:')
  assert.equal(u.hostname,'127.0.0.1')
  assert.equal(Number(u.port),expectedPort)
  assert.equal(u.username,'');assert.equal(u.password,'');assert.equal(u.search,'');assert.equal(u.hash,'')
  if(websocket)assert(/^\/devtools\/page\/[A-Za-z0-9-]+$/.test(u.pathname))
  else assert.equal(u.pathname,'/json/list')
  return u.href
}
export function installedTarget(target,expectedWelcomeUrl){
  assert.equal(target.type,'page')
  const u=new URL(target.url)
  // Actual packaged shell routes only; no web scaffold or arbitrary browser page.
  if(u.protocol==='file:'){
    assert(typeof expectedWelcomeUrl==='string'&&expectedWelcomeUrl.startsWith('file:'))
    assert.equal(u.href,expectedWelcomeUrl)
  }else{
    assert.equal(u.protocol,'dsh-app:');assert.equal(u.hostname,'app')
  }
  return target
}
