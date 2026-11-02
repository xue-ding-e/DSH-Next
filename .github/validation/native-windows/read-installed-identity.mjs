// Bounded read-only package.json reader; archive layout cross-checked against
// https://github.com/electron/asar/blob/main/src/disk.ts readArchiveHeaderSync/readFileSync.
// Does not execute or extract archive code, follow links, or mutate installed files.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
export function readManifest(archive) {
  const fd=openSync(archive,'r')
  try {
    const total=fstatSync(fd).size
    const read=(n,off)=>{assert(Number.isSafeInteger(n)&&n>0&&off>=0&&off+n<=total);const b=Buffer.alloc(n);assert.equal(readSync(fd,b,0,n,off),n);return b}
    const size=read(8,0);assert.equal(size.readUInt32LE(0),4)
    const headerSize=size.readUInt32LE(4);assert(headerSize>=8&&headerSize<=16*1024*1024)
    const header=read(headerSize,8);const payload=header.readUInt32LE(0),length=header.readUInt32LE(4)
    assert(payload+4===headerSize&&length>0&&length<=payload-4)
    const data=JSON.parse(header.subarray(8,8+length).toString('utf8'))
    assert(data.files&&Object.hasOwn(data.files,'package.json'))
    const entry=data.files['package.json'];assert(!entry.link&&!entry.unpacked&&!entry.files,'only packed root manifest supported')
    assert(typeof entry.offset==='string'&&/^\d+$/.test(entry.offset))
    const offset=Number(entry.offset);assert(Number.isSafeInteger(offset))
    assert(Number.isSafeInteger(entry.size)&&entry.size>0&&entry.size<=1024*1024)
    const bytes=read(entry.size,8+headerSize+offset),sha256=createHash('sha256').update(bytes).digest('hex')
    if(entry.integrity){assert.equal(entry.integrity.algorithm,'SHA256');assert.equal(entry.integrity.hash,sha256)}
    return {manifest:JSON.parse(bytes.toString('utf8')),manifestSha256:sha256}
  } finally {closeSync(fd)}
}
export function validateIdentity(result,version,commit,channel) {
  const m=result.manifest
  assert.equal(m.name,'dsh-next-desktop');assert.equal(m.productName,'DSH Next')
  assert.equal(m.dshDesktopAppId,'io.github.xue-ding-e.dsh-next')
  assert.equal(m.version,version);assert.equal(m.dshDesktopUpdateChannel,channel)
  assert.equal(m.dshBuildCommit,commit);assert.equal(m.dshBuildDirty,false)
  assert.equal(m.dshNext?.repository,'xue-ding-e/DSH-Next');assert.equal(m.dshNext.repositoryId,1437727533)
  return {version:m.version,channel:m.dshDesktopUpdateChannel,sourceSha:m.dshBuildCommit,dirty:m.dshBuildDirty,packageName:m.name,productName:m.productName,manifestSha256:result.manifestSha256}
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href){const [file,version,commit,channel]=process.argv.slice(2);assert(file&&version&&/^[0-9a-f]{40}$/.test(commit)&&channel);console.log(JSON.stringify(validateIdentity(readManifest(file),version,commit,channel)))}
