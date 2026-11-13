/** Verify the real installed Electron entry and wait for its Host to start. */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'
import { spawnSync } from 'node:child_process'

const [root, executable, version] = process.argv.slice(2)
assert.ok(root && executable && version)
const journal = join(root, 'journal-' + version)
const initialJournal = new Set(await readdir(journal).catch(error => {
  if (error.code === 'ENOENT') return []
  throw error
}))
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(?:SystemRoot|SystemDrive|WINDIR|ComSpec|Path|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/iu.test(name)))
assert.ok(environment.SystemRoot)
const app = await _electron.launch({
  executablePath: executable,
  args: ['--user-data-dir=' + join(root, 'electron'), '--disable-background-networking', '--disable-component-update'],
  env: {
    ...environment, DSH_NEXT_HOME: join(root, 'next-home'), DSH_HOME: join(root, 'official-home'),
    DSH_TELEMETRY_DISABLED: '1', DSH_DESKTOP_UPDATE_JOURNAL_DIR: journal,
  },
  timeout: 60_000,
})
const processHandle = app.process()
try {
  await app.firstWindow({ timeout: 60_000 })
  const installed = await app.evaluate(({ app }) => ({
    version: app.getVersion(), packaged: app.isPackaged, executable: process.execPath, pid: process.pid,
  }))
  assert.equal(installed.version, version)
  assert.equal(installed.packaged, true)
  assert.equal(installed.executable.toLowerCase(), executable.toLowerCase())
  const deadline = Date.now() + 90_000
  let ready = false
  while (!ready && Date.now() < deadline) {
    for (const file of (await readdir(journal)).filter(name => !initialJournal.has(name))) {
      const events = (await readFile(join(journal, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.ok(events.every(event => event.version === version && event.pid === installed.pid))
      assert.ok(!events.some(event => event.event === 'workspace-failed'), 'Installed Host startup failed')
      ready ||= events.some(event => event.event === 'workspace-ready')
    }
    if (!ready) await delay(200)
  }
  assert.ok(ready, 'Installed Host did not become ready')
} finally {
  let timer
  try {
    await Promise.race([app.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Installed Electron did not quit')), 30_000)
    })])
  } catch (error) {
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      spawnSync(join(environment.SystemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
assert.equal(processHandle.exitCode, 0)
