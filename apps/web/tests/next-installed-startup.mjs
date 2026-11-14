/** Verify the real installed Electron entry and wait for its Host to start. */
import assert from 'node:assert/strict'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'
import { spawnSync } from 'node:child_process'

const [root, executable, version, installer, successor] = process.argv.slice(2)
assert.ok(root && executable && version)
assert.equal(Boolean(installer), Boolean(successor))
const journal = join(root, 'journal-' + version)
const initialJournal = new Set(await readdir(journal).catch(error => {
  if (error.code === 'ENOENT') return []
  throw error
}))
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(?:SystemRoot|SystemDrive|WINDIR|ComSpec|Path|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/iu.test(name)))
assert.ok(environment.SystemRoot)

// Only the disposable installation consumes this feed. NSIS replaces its config with the packaged GitHub feed.
let feed
let installerRequests = 0
let offerUpdate = false
if (installer && successor) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.GITHUB_REPOSITORY_ID, '1437727533')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(installer)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const size = (await stat(installer)).size
  const manifest = next => JSON.stringify({
    version: next, files: [{ url: 'candidate.exe', size, sha512 }],
    path: 'candidate.exe', sha512, releaseDate: '2026-11-13T00:00:00.000Z',
  })
  feed = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (path === '/rc.yml') {
      response.end(manifest(offerUpdate ? successor : version))
    } else if (path === '/candidate.exe' && !request.headers.range) {
      installerRequests++
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size })
      void pipeline(createReadStream(installer), response).catch(error => response.destroy(error))
    } else {
      response.writeHead(404).end()
    }
  })
}

async function waitFor(check, description, timeout = 90_000) {
  const deadline = Date.now() + timeout
  do {
    const result = await check()
    if (result) return result
    await delay(200)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

async function readEvents(directory, expectedVersion, exclude = new Set()) {
  const traces = []
  for (const file of (await readdir(directory)).filter(name => !exclude.has(name))) {
    const lines = (await readFile(join(directory, file), 'utf8')).split('\n')
    // A concurrent append may leave an incomplete tail in this observation.
    lines.pop()
    if (lines.length === 0) continue
    const events = lines.map(line => JSON.parse(line))
    assert.ok(events.every(event => event.version === expectedVersion && event.pid === events[0].pid))
    traces.push(events)
  }
  return traces
}

let app
let processHandle
try {
  if (feed) {
    const listening = once(feed, 'listening')
    feed.listen(0, '127.0.0.1')
    await listening
    await writeFile(join(dirname(executable), 'resources', 'app-update.yml'), JSON.stringify({
      provider: 'generic', url: `http://127.0.0.1:${feed.address().port}/`, channel: 'rc',
      updaterCacheDirName: 'dsh-next-restart-qualification-' + randomUUID(),
    }))
  }
  app = await _electron.launch({
    executablePath: executable,
    args: ['--user-data-dir=' + join(root, 'electron'), '--disable-background-networking', '--disable-component-update'],
    env: {
      ...environment, DSH_NEXT_HOME: join(root, 'next-home'), DSH_HOME: join(root, 'official-home'),
      DSH_TELEMETRY_DISABLED: '1', DSH_DESKTOP_UPDATE_JOURNAL_DIR: journal,
    },
    timeout: 60_000,
  })
  processHandle = app.process()
  await app.firstWindow({ timeout: 60_000 })
  const installed = await app.evaluate(({ app }) => ({
    version: app.getVersion(), packaged: app.isPackaged, executable: process.execPath, pid: process.pid,
  }))
  assert.equal(installed.version, version)
  assert.equal(installed.packaged, true)
  assert.equal(installed.executable.toLowerCase(), executable.toLowerCase())
  await waitFor(async () => {
    for (const events of await readEvents(journal, version, initialJournal)) {
      assert.equal(events[0].pid, installed.pid)
      assert.ok(!events.some(event => event.event === 'workspace-failed'), 'Installed Host startup failed')
      if (events.some(event => event.event === 'workspace-ready')) return true
    }
  }, 'installed Host readiness')

  if (feed) {
    // Start the installer from the same working directory that the Windows shortcut gives Electron.
    assert.equal(await app.evaluate((_electron, directory) => {
      process.chdir(directory)
      return process.cwd()
    }, dirname(executable)), dirname(executable))
    offerUpdate = true
    const welcome = app.windows().find(window => window.url().startsWith('file:') && new URL(window.url()).pathname.endsWith('/welcome.html'))
    if (welcome) await welcome.evaluate(() => window.dshWelcome.skip())
    const workspace = await waitFor(() => app.windows().find(window => window.url().startsWith('dsh-app://app/')), 'workspace')
    await workspace.evaluate(() => { void window.dshDesktop.updates.open() })
    const confirm = (labels) => waitFor(() => app.evaluate(({ webContents }, expected) => {
      const dialog = webContents.getAllWebContents().find(view => view.getURL() === 'dsh-app://shell/update-dialog.html')
      return dialog?.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('#actions button')].find(
          item => !item.disabled && ${JSON.stringify(expected)}.includes(item.textContent))
        if (!button) return false
        const label = button.textContent
        button.click()
        return label
      })()`)
    }, labels), labels.join(' / '), 180_000)
    // The sidebar starts the transfer directly. Also accept a separate download prompt.
    const restart = ['Install and Restart', '安装并重启']
    const action = await confirm([...restart, 'Download update', '下载更新'])
    if (!restart.includes(action)) await confirm(restart)
    await waitFor(() => processHandle.exitCode !== null, 'old Electron exit', 60_000)
    assert.equal(processHandle.exitCode, 0)
    assert.ok(installerRequests > 0, 'Updater never requested the actual installer')
    const traces = await readEvents(journal, version, initialJournal)
    const events = traces.flat()
    const milestones = [
      events.findIndex(row => row.event === 'state' && row.phase === 'ready' && row.targetVersion === successor),
      events.findIndex(row => row.event === 'install-confirmed'),
      events.findIndex(row => row.event === 'quit-requested'),
    ]
    assert.ok(milestones[0] >= 0 && milestones[0] < milestones[1] && milestones[1] < milestones[2], JSON.stringify(milestones))
  }
} finally {
  let timer
  try {
    if (processHandle?.exitCode === null) await Promise.race([app.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Installed Electron did not quit')), 30_000)
    })])
  } catch (error) {
    if (processHandle?.exitCode === null && processHandle.signalCode === null) {
      spawnSync(join(environment.SystemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 })
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (feed?.listening) {
      const closed = new Promise((resolve, reject) => feed.close(error => error ? reject(error) : resolve()))
      feed.closeAllConnections()
      await closed
    }
  }
}
assert.equal(processHandle.exitCode, 0)
