import assert from 'node:assert/strict'
import { win32 as path } from 'node:path'

export const SOURCE = '270dd45091805cb504fdd39bf09d9ec596ca4150'
// Exact reviewed artifact identities, not a general SHA/version permission.
const REVIEWED_PACKAGES = Object.freeze([
  Object.freeze({ source: SOURCE, version: '0.2.1-rc.3.20261029.1' }),
  Object.freeze({ source: '097405ae7f990d34a17a2afe689db17df55932a3', version: '0.2.1-rc.3.20261029.2' }),
])
export function verifyReviewedPackage(source, version) {
  assert(REVIEWED_PACKAGES.some(item => item.source === source && item.version === version), 'unreviewed source/version pair')
}
export function verifyPackageAttestation(request, attestation) {
  verifyReviewedPackage(request.source, request.version)
  assert.equal(attestation.source, request.source, 'attestation belongs to another source')
  assert.equal(attestation.version, request.version, 'attestation belongs to another version')
}
export const PROFILE_PATCH = '- id: session-telemetry-otel\n  disabled: true\n- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n'
const norm = value => path.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
export function inside(root, value) {
  const relative = path.relative(norm(root), norm(value))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
export function runtimeEnvironment(systemRoot, root) {
  assert(path.isAbsolute(systemRoot) && path.isAbsolute(root))
  const home = path.join(root, 'home'), temp = path.join(root, 'temp')
  return {
    SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: path.parse(systemRoot).root.slice(0, 2),
    ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    PATH: [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'Wbem'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
    APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
    TEMP: temp, TMP: temp, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    DSH_HOME: path.join(home, '.dsh'), DSH_NEXT_HOME: path.join(home, '.dsh-next'),
    DSH_TELEMETRY_DISABLED: '1',
  }
}
/** Only a WebSocket endpoint printed by this spawned process may be passed here. */
export function inspectorEndpoint(line) {
  const match = /^Debugger listening on (ws:\/\/127\.0\.0\.1:(\d+)\/([a-f0-9-]{36}))$/.exec(line.trim())
  assert(match, 'not a loopback ephemeral owned inspector endpoint')
  const port = Number(match[2]); assert(port > 0 && port <= 65535)
  return match[1]
}
export function verifyRuntimeIdentity(value, expected) {
  assert.equal(value.isPackaged, true)
  assert.equal(norm(value.execPath), norm(expected.exe))
  assert.equal(norm(value.appPath), norm(path.join(path.dirname(expected.exe), 'resources', 'app.asar')))
  assert.equal(value.version, expected.version)
  assert.equal(value.electron, '44.7.0')
  assert.equal(value.ready, true)
  assert.equal(value.defaultProtocol, true, 'real application has not registered its protocol')
  assert.equal(norm(value.userData), norm(path.join(expected.root, 'userData')))
  assert(inside(expected.root, value.logs) && inside(expected.root, value.home) && inside(expected.root, value.cwd))
  assert.equal(norm(value.nextHome), norm(path.join(expected.root, 'home', '.dsh-next')))
  assert.equal(norm(value.dshHome), norm(value.nextHome))
  assert.equal(value.telemetryDisabled, '1')
  assert.equal(value.runAsNode, false)
  assert(value.windows.some(window => /[\\/]lib[\\/]welcome[\\/]/.test(window.url) || /\/welcome(?:[/.?#]|$)/.test(window.url)), 'no real welcome window observed')
}
export function verifyProtocolSnapshots(before, after, exe) {
  const command = `"${exe}" "%1"`
  assert.equal(before.length, 4); assert.equal(after.length, 4)
  const keys = new Set()
  for (const entry of after) {
    assert(['CurrentUser', 'LocalMachine'].includes(entry.hive))
    assert(['Registry64', 'Registry32'].includes(entry.view))
    const key = `${entry.hive}/${entry.view}`; assert(!keys.has(key)); keys.add(key)
    const previous = before.find(x => x.hive === entry.hive && x.view === entry.view); assert(previous)
    // Machine state is never changed by this per-user validation.
    if (entry.hive === 'LocalMachine') assert.deepEqual(entry, previous)
    else {
      if (previous.exists) assert.equal(previous.command, command, 'pre-existing foreign user handler')
      assert.equal(entry.command, command)
      assert.equal(entry.exists, true)
      assert.equal(entry.urlProtocolPresent, true)
    }
  }
}
