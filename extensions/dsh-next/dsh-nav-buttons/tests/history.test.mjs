/**
 * Side-button navigation: one back/forward history over sessions, panels and tabs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { NavHistory, ownsOwnHistory, sideButton } from '../lib/history.js'

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('the shipped client registers through the classic-script module loader', () => {
  const modules = []
  new Script(clientSource, { filename: 'dsh-nav-buttons/client.js' }).runInNewContext({
    window: { __ModuleLoader__: { load(module) { modules.push(module) } } },
  })
  assert.equal(modules.length, 1)
  assert.equal(modules[0].id, 'dsh-nav-buttons')
  const plugin = modules[0].factory()
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(Array.from(plugin.inject), ['sidebarRight'])
})

test('the client bundle is a classic script with no ESM syntax', () => {
  // A top-level export/import crashes the Harness shell at boot.
  assert.ok(clientSource.trimStart().startsWith('window.__ModuleLoader__.load({'))
  assert.equal(/^\s*(export\s|import\s)/m.test(clientSource), false)
})

test('a fresh history cannot move in either direction', () => {
  const history = new NavHistory()
  assert.deepEqual(history.snapshot, { current: undefined, canGoBack: false, canGoForward: false, size: 0, keys: [] })
  assert.equal(history.back(), undefined)
  assert.equal(history.forward(), undefined)
})

test('visits accumulate and back/forward walk them', () => {
  const history = new NavHistory()
  history.visit('a')
  history.visit('b')
  history.visit('c')
  assert.deepEqual(history.snapshot, { current: { key: 'c' }, canGoBack: true, canGoForward: false, size: 3, keys: ['a', 'b', 'c'] })
  assert.deepEqual(history.back(), { key: 'b' })
  assert.deepEqual(history.back(), { key: 'a' })
  assert.equal(history.back(), undefined)
  assert.deepEqual(history.forward(), { key: 'b' })
  assert.deepEqual(history.forward(), { key: 'c' })
  assert.equal(history.forward(), undefined)
})

test('revisiting the current place is a no-op', () => {
  const history = new NavHistory()
  history.visit('a')
  assert.equal(history.visit('a'), false)
  assert.equal(history.snapshot.size, 1)
})

test('a new visit after going back drops the forward branch', () => {
  const history = new NavHistory()
  history.visit('a')
  history.visit('b')
  history.visit('c')
  history.back()
  history.back()
  history.visit('d')
  assert.deepEqual(history.snapshot, { current: { key: 'd' }, canGoBack: true, canGoForward: false, size: 2, keys: ['a', 'd'] })
  assert.deepEqual(history.back(), { key: 'a' })
})

test('revisiting a place already in the stack jumps to it and truncates', () => {
  const history = new NavHistory()
  for (const key of ['a', 'b', 'c', 'd']) history.visit(key)
  history.visit('b')
  assert.deepEqual(history.snapshot, { current: { key: 'b' }, canGoBack: true, canGoForward: false, size: 2, keys: ['a', 'b'] })
  assert.deepEqual(history.forward(), undefined)
})

test('the stack is bounded and keeps the newest entries', () => {
  const history = new NavHistory(3)
  for (const key of ['a', 'b', 'c', 'd', 'e']) history.visit(key)
  assert.equal(history.snapshot.size, 3)
  assert.deepEqual(history.snapshot.current, { key: 'e' })
  // Only the two most recent predecessors remain reachable.
  assert.deepEqual(history.back(), { key: 'd' })
  assert.deepEqual(history.back(), { key: 'c' })
  assert.equal(history.back(), undefined)
})

test('a limit below two is refused', () => {
  assert.throws(() => new NavHistory(1), /limit of at least 2/)
  assert.throws(() => new NavHistory(0), /limit of at least 2/)
})

test('clear forgets everything', () => {
  const history = new NavHistory()
  history.visit('a')
  history.visit('b')
  history.clear()
  assert.deepEqual(history.snapshot, { current: undefined, canGoBack: false, canGoForward: false, size: 0, keys: [] })
})

test('only the two thumb buttons are claimed', () => {
  assert.equal(sideButton(3), 'back')
  assert.equal(sideButton(4), 'forward')
  for (const button of [0, 1, 2, 5]) assert.equal(sideButton(button), undefined)
})

test('the sidebar browser guest keeps its own page history', () => {
  const guest = { tagName: 'WEBVIEW' }
  assert.equal(ownsOwnHistory(guest), true)
  const insideGuest = { tagName: 'DIV', closest: selector => (selector.includes('webview') ? { tagName: 'WEBVIEW' } : null) }
  assert.equal(ownsOwnHistory(insideGuest), true)
  const chat = { tagName: 'DIV', closest: () => null }
  assert.equal(ownsOwnHistory(chat), false)
  assert.equal(ownsOwnHistory(null), false)
  assert.equal(ownsOwnHistory(undefined), false)
})

test('a full session/panel/tab walk composes one history', () => {
  // The three id spaces are joined unambiguously, so switching only the panel
  // still records a distinct place.
  const history = new NavHistory()
  const place = (session, panel, tab) => [session, panel, tab].join('\u0001')
  history.visit(place('s1', 'chat', 't1'))
  history.visit(place('s1', 'files', 't1'))
  history.visit(place('s2', 'files', 't1'))
  history.visit(place('s2', 'files', 't2'))
  assert.equal(history.snapshot.size, 4)
  // Walking back retraces exactly the recorded order, one place per step.
  assert.deepEqual(history.back(), { key: place('s2', 'files', 't1') })
  assert.deepEqual(history.back(), { key: place('s1', 'files', 't1') })
  assert.deepEqual(history.back(), { key: place('s1', 'chat', 't1') })
  assert.equal(history.back(), undefined, 'the first place is the end of the past')
  assert.deepEqual(history.forward(), { key: place('s1', 'files', 't1') })
})

/** Minimal node request/response pair for one diagnostics call. */
function call(route, method, endpoint, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: `/tool-nav-buttons/${endpoint}`,
    on(event, handler) {
      if (event === 'data') for (const chunk of payload) handler(chunk)
      if (event === 'end') handler()
    },
  }
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(code) { this.status = code; return this },
      end(text) { resolve({ status: this.status, body: text }) },
    }
    route.handler(req, res)
  })
}

test('the host half exposes a diagnostics route for the browser half', async () => {
  const routes = new Map()
  const webServer = { register(route) { routes.set(route.path, route); return () => {} } }
  const ctx = {
    // The host half declares `inject: ['webServer']`, so Cordis resolves the
    // property on the context itself; the fixture must expose it the same way.
    webServer,
    effect(install) { install(); return () => {} },
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx)
  const route = routes.get('/tool-nav-buttons')
  assert.ok(route, 'diagnostics route is registered')

  // Before any report, the status must say so rather than pretend all is well.
  const empty = await call(route, 'GET', 'status')
  assert.equal(empty.status, 200)
  const idle = JSON.parse(empty.body)
  assert.equal(idle.pageHalf, 'awaiting first report')
  // The wording matters: after a host reload this half has no state, and a
  // healthy page is indistinguishable from a missing one until it reports. The
  // response must say so rather than implying the page is broken.
  assert.ok(typeof idle.note === 'string' && idle.note.length > 0, 'explains what to do')

  // A report from the page flips it to a concrete, countable state.
  const posted = await call(route, 'POST', 'report', {
    loadedAt: 1700000000000, visits: 7, backs: 2, forwards: 1, entries: 5, index: 0,
  })
  assert.equal(posted.status, 204)

  const reported = await call(route, 'GET', 'status')
  const state = JSON.parse(reported.body)
  assert.equal(state.pageHalf, 'reported')
  assert.equal(state.visits, 7)
  assert.equal(state.backs, 2)
  assert.equal(state.forwards, 1)

  // A malformed report is refused instead of poisoning the counters.
  const bad = await call(route, 'POST', 'report', undefined)
  assert.equal(bad.status, 400)
  assert.equal(await call(route, 'GET', 'nope').then(r => r.status), 404)
})

test('the browser half reads the services that actually move for each axis', () => {
  // These three names are the whole correctness story for "which place is this":
  // the session controller keeps retention under `mainView` inside `sessions.list`,
  // the layout exposes selection as `panelInfo.activePanelId`, and the Sidebar
  // exposes its own session as `mounted`. Reading any other member silently
  // yields "unchanged" and the feature appears dead.
  assert.ok(clientSource.includes('sessions?.list?.getSnapshot'), 'session axis reads sessions.list')
  assert.ok(clientSource.includes('panelInfo?.getSnapshot'), 'panel axis reads layout.panelInfo')
  assert.ok(clientSource.includes("ctx.get('sidebarRight')?.mounted"), 'tab axis reads sidebarRight.mounted')
  assert.ok(clientSource.includes('retainedBy?.mainView'), 'session axis keys off mainView retention')
})

test('position reports the real cursor, not a placeholder', () => {
  // The plugin reports `index` to the Host so an operator can see where the stack
  // stands. It previously sent a constant 0/-1, which made every stack look empty
  // however deep it actually was.
  const history = new NavHistory()
  assert.equal(history.position, -1, 'empty stack is -1')

  history.visit('a')
  assert.equal(history.position, 0)
  history.visit('b')
  history.visit('c')
  assert.equal(history.position, 2)

  history.back()
  assert.equal(history.position, 1, 'back moves the cursor')
  history.forward()
  assert.equal(history.position, 2, 'forward moves it back')
})

test('position tracks truncation and revisit jumps', () => {
  const history = new NavHistory()
  for (const key of ['a', 'b', 'c', 'd']) history.visit(key)
  history.back()
  history.back()
  assert.equal(history.position, 1)

  // Revisiting an earlier place keeps the cursor on it.
  history.visit('a')
  assert.equal(history.position, 0)
  assert.equal(history.snapshot.size, 1)
})

test('the tab axis reads sidebarRight.active(), not a member that does not exist', () => {
  // `ctx.sidebarRight` has no `state` and no `getSnapshot`; it exposes `active()`
  // for "the active tab of the active pane". The earlier code read
  // `sidebarRight.state.getSnapshot()`, which is undefined forever, so switching
  // sidebar tabs never produced a new place — while `sources.tab` still reported
  // healthy because it only checked `mounted.subscribe`.
  // Strip comments first: the source documents the WRONG accessor it replaced, and
  // a raw substring check would fail on that documentation rather than on code.
  const code = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(code.includes('sidebarRight.active()'), 'reads the real accessor')
  assert.equal(code.includes('sidebarRight.state'), false, 'no phantom member in code')
  // The health check must cover the reader too, or the axis lies again.
  assert.ok(code.includes("sidebarRight')?.active === 'function'"), 'health checks active()')
})

test('the tab axis is sampled, because no observable reports it', () => {
  // `ISidebarRight` exposes exactly one observable, `mounted`, and its contract is
  // "moves only when the on-screen Session changes; the Session's own store
  // commits are silent". A tab switch therefore emits no event at all. The tab
  // axis must be sampled or every tab change is lost — which is what happened.
  const code = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  // Interaction-driven, not timer-driven: Chromium throttles background-tab
  // timers and this document is usually backgrounded (measured 1 tick per 10 s).
  assert.ok(code.includes("record(true), 0"), 'records on the interaction, deferred a task')
  assert.equal(code.includes('setInterval(() => record(true)'), false, 'no throttled timer')

  // Samples must not be counted as observer firings, or the diagnostic that
  // distinguishes "record is dead" from "nothing moved" stops meaning anything.
  assert.ok(code.includes('if (fromSample) sampleCalls++'), 'samples counted apart')
  assert.ok(code.includes('recordCalls++'), 'observer firings still counted')
  assert.ok(code.includes('sampleCalls,'), 'sample count is reported')
})

test('the command mailbox lets navigation be exercised without real input', async () => {
  // Driving X1/X2 for real means synthesizing mouse input on the operator's
  // machine. The mailbox replaces that: the test asks for a direction over HTTP
  // and the page half performs it on its next drain. Without this the navigation
  // path can only be verified by taking over the user's mouse.
  const routes = new Map()
  const webServer = { register(route) { routes.set(route.path, route); return () => {} } }
  const ctx = { webServer, effect(install) { install(); return () => {} } }
  const { apply } = await import('../lib/index.js')
  apply(ctx)
  {
    const route = routes.get('/tool-nav-buttons')

    const empty = await call(route, 'GET', 'command')
    assert.equal(JSON.parse(empty.body).command, null, 'mailbox starts empty')

    const queued = await call(route, 'POST', 'command', { command: 'back' })
    assert.equal(queued.status, 202)
    assert.equal(JSON.parse(queued.body).queued, 'back')

    const drained = await call(route, 'GET', 'command')
    assert.equal(JSON.parse(drained.body).command, 'back')

    // Single slot: draining clears it, so stale directions cannot pile up.
    const afterDrain = await call(route, 'GET', 'command')
    assert.equal(JSON.parse(afterDrain.body).command, null)

    // An unknown command is rejected rather than parked for the page to misread.
    const bad = await call(route, 'POST', 'command', { command: 'explode' })
    assert.equal(bad.status, 400)
  }
})

test('snapshot.keys exposes the entries, so a stuck cursor is diagnosable', () => {
  // `size` alone cannot distinguish "two distinct places" from "one place recorded
  // twice", and when a back step reports there is nowhere to go that is exactly
  // the question. The contents answer it.
  const history = new NavHistory()
  assert.deepEqual(history.snapshot.keys, [])

  for (const key of ['a', 'b', 'c']) history.visit(key)
  assert.deepEqual(history.snapshot.keys, ['a', 'b', 'c'])

  history.back()
  assert.deepEqual(history.snapshot.keys, ['a', 'b', 'c'], 'moving does not drop entries')
  assert.equal(history.position, 1)

  // Revisiting truncates, and the keys follow.
  history.visit('a')
  assert.deepEqual(history.snapshot.keys, ['a'])
})

test('walks a real session+tab key stream the way X1/X2 must', () => {
  // Mirrors the exact key format the page half builds (session, panel, tab joined
  // by U+0001) with the tab axis active and the panel axis empty — the shape this
  // workspace actually reports. Proves the navigation logic is sound on its own,
  // independent of whether the running page has the latest code.
  const SESSION = 'session-1717371d-adf4-4c37-8d02-0d61ee5e23ac'
  const key = tab => `${SESSION}\u0001\u0001${tab}`
  const tabOf = entry => entry.key.split('\u0001').pop()

  const history = new NavHistory()
  history.visit(key('tab5'))
  history.visit(key('tab7'))
  assert.equal(history.position, 1, 'two places, cursor at the newest')

  // X1
  assert.equal(tabOf(history.back()), 'tab5')
  assert.equal(history.position, 0)
  assert.equal(history.snapshot.canGoBack, false, 'at the oldest end')

  // X2
  assert.equal(tabOf(history.forward()), 'tab7')
  assert.equal(history.position, 1)

  // Walking back past the start yields nothing rather than wrapping or throwing.
  assert.equal(tabOf(history.back()), 'tab5')
  assert.equal(history.back(), undefined)
  assert.equal(history.position, 0)
})
