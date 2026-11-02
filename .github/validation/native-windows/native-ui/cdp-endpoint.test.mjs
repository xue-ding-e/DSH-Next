import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loopbackEndpoint,installedTarget} from './cdp-endpoint.mjs'
test('accept fixed loopback discovery and page websocket',()=>{loopbackEndpoint('http://127.0.0.1:9222/json/list',9222);loopbackEndpoint('ws://127.0.0.1:9222/devtools/page/ABC-123',9222,{websocket:true})})
for(const url of ['http://localhost:9222/json/list','http://0.0.0.0:9222/json/list','http://127.0.0.1:9223/json/list','https://127.0.0.1:9222/json/list','http://user:pass@127.0.0.1:9222/json/list','http://127.0.0.1:9222/json/list?token=x','http://example.com:9222/json/list'])test('reject endpoint '+url,()=>assert.throws(()=>loopbackEndpoint(url,9222)))
test('accept installed app page',()=>installedTarget({type:'page',url:'dsh-app://app/'}))
for(const target of [{type:'page',url:'http://127.0.0.1:3080/'},{type:'service_worker',url:'dsh-app://app/'},{type:'page',url:'dsh-app://foreign/'}])test('reject noninstalled target '+JSON.stringify(target),()=>assert.throws(()=>installedTarget(target)))

test('accept only exact installed welcome file',()=>{const url='file:///D:/synthetic/Installed%20App/resources/app.asar/renderer/welcome.html';installedTarget({type:'page',url},url);assert.throws(()=>installedTarget({type:'page',url:'file:///C:/foreign/welcome.html'},url));assert.throws(()=>installedTarget({type:'page',url}));})
