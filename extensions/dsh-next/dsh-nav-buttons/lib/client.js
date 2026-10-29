window.__ModuleLoader__.load({
  id: 'dsh-nav-buttons',
  factory() {
/**
 * Mouse side buttons for the Harness web app.
 *
 * One history, three kinds of movement. A "place" is `session|panel|tab`, so
 * switching session, switching the main panel and focusing a sidebar tab all
 * append to the same stack. X1 walks back, X2 walks forward — no new shortcuts
 * to learn, and the gesture works even while focus sits in the chat composer.
 *
 * The sidebar browser page is exempt: its `<webview>` shows a real web page and
 * keeps its own history, so a side press inside it must reach that guest.
 *
 * The history primitives live in `./history.js` for the Node test suite and are
 * pasted here verbatim: a client bundle is delivered as a classic script, so it
 * cannot carry an ESM `import`.
 */

/** Separator that keeps the three id spaces unambiguous in one key. */
const SEP = '\u0001'

/** A bounded back/forward history of visited places. */
class NavHistory {
  #entries = []
  #index = -1
  #limit

  constructor(limit = 200) {
    if (!Number.isInteger(limit) || limit < 2) throw new Error('NavHistory needs a limit of at least 2')
    this.#limit = limit
  }

  get snapshot() {
    return {
      current: this.#index >= 0 ? this.#entries[this.#index] : undefined,
      canGoBack: this.#index > 0,
      canGoForward: this.#index >= 0 && this.#index < this.#entries.length - 1,
      size: this.#entries.length,
    }
  }

  visit(key) {
    if (key === '') return false
    if (this.#entries[this.#index]?.key === key) return false
    const existing = this.#entries.findIndex(entry => entry.key === key)
    if (existing >= 0) {
      this.#index = existing
      this.#entries = this.#entries.slice(0, existing + 1)
      return true
    }
    this.#entries = this.#entries.slice(0, this.#index + 1)
    this.#entries.push({ key })
    this.#index = this.#entries.length - 1
    if (this.#entries.length > this.#limit) {
      const excess = this.#entries.length - this.#limit
      this.#entries = this.#entries.slice(excess)
      this.#index -= excess
    }
    return true
  }

  back() {
    if (this.#index <= 0) return undefined
    this.#index -= 1
    return this.#entries[this.#index]
  }

  forward() {
    if (this.#index < 0 || this.#index >= this.#entries.length - 1) return undefined
    this.#index += 1
    return this.#entries[this.#index]
  }

  clear() {
    this.#entries = []
    this.#index = -1
  }
}

/** @param button - `MouseEvent.button`. @returns 'back', 'forward', or undefined. */
function sideButton(button) {
  if (button === 3) return 'back'
  if (button === 4) return 'forward'
  return undefined
}

/** @param target - event target. @returns true when that surface owns its own history. */
function ownsOwnHistory(target) {
  if (typeof target !== 'object' || target === null) return false
  if (typeof target.tagName === 'string' && target.tagName.toLowerCase() === 'webview') return true
  if (typeof target.closest !== 'function') return false
  return target.closest('webview[data-sidebar-browser-frame]') !== null
}

/**
 * Compose the identity of one place.
 * @param sessionId - owning session, or undefined before one is open.
 * @param panel - main panel id, or null.
 * @param tabId - focused sidebar tab, or undefined.
 * @returns the history key.
 */
function placeKey(sessionId, panel, tabId) {
  return [sessionId ?? '', panel ?? '', tabId ?? ''].join(SEP)
}

/**
 * Split a history key back into its parts.
 * @param key - a key produced by {@link placeKey}.
 * @returns the three parts.
 */
function parseKey(key) {
  const [sessionId = '', panel = '', tabId = ''] = key.split(SEP)
  return {
    sessionId: sessionId === '' ? undefined : sessionId,
    panel: panel === '' ? null : panel,
    tabId: tabId === '' ? undefined : tabId,
  }
}

/**
 * Read the session occupying the MAIN view.
 *
 * `sidebarRight.mounted` only tracks what the right Sidebar is showing, so it
 * stays put while the user switches sessions in the main area — the exact
 * movement this feature exists for. The authoritative signal is retention: the
 * session some view holds under `mainView`. Reading the session list and taking
 * the one retained by the main view follows the same rule as the session
 * controller's own `publishMain`.
 * @param sessions - `ctx.sessions`.
 * @returns the main-view session id, or undefined when none is open.
 */
function mainSessionId(sessions) {
  const list = sessions?.list?.getSnapshot?.()
  const byId = list?.byId
  if (byId === undefined || byId === null) return undefined
  for (const candidate of Object.values(byId)) {
    if ((candidate?.retainedBy?.mainView ?? 0) > 0) return candidate.id
  }
  return undefined
}

/**
 * Read the place the window is showing right now.
 * @param ctx - client plugin context.
 * @returns the current key, or undefined when nothing is open yet.
 */
function currentPlace(ctx) {
  const sessions = ctx.get('sessions')
  const layout = ctx.get('layout')
  const sidebarRight = ctx.get('sidebarRight')
  // The main view is what X1/X2 must walk; the sidebar's own session is a
  // separate axis that would otherwise mask every main-view switch.
  const sessionId = mainSessionId(sessions)
  const panel = layout === undefined ? null : layoutPanel(layout)
  const tabId = sidebarRight === undefined ? undefined : focusedTab(ctx)
  if (sessionId === undefined && panel === null && tabId === undefined) return undefined
  return placeKey(sessionId, panel, tabId)
}

/**
 * Read the currently selected main panel.
 *
 * `ctx.layout` exposes the selection as `panelInfo` (a `HostObservable` whose
 * snapshot is `{ activePanelId }`), not as a plain `getSnapshot()` on the
 * service. Reading the wrong member silently yields "no panel", which would make
 * every place look identical apart from its session.
 * @param layout - `ctx.layout`.
 * @returns the panel id, or null when the Conversation is showing.
 */
function layoutPanel(layout) {
  const info = layout?.panelInfo?.getSnapshot?.()
  const selected = info?.activePanelId
  return typeof selected === 'string' ? selected : null
}

/**
 * Read the focused sidebar tab.
 *
 * `ctx.sidebarRight` exposes `active()` — "the active tab of the active pane" —
 * and that is the only public reader for the selection. The previous version
 * reached for `sidebarRight.state.getSnapshot()`, which does not exist on the
 * controller, so this returned undefined forever and the tab axis was silently
 * dead: switching sidebar tabs never produced a new place.
 * @param ctx - client plugin context.
 * @returns the tab id or undefined.
 */
function focusedTab(ctx) {
  const sidebarRight = ctx.get('sidebarRight')
  if (typeof sidebarRight?.active !== 'function') return undefined
  const tab = sidebarRight.active()
  // TabRecord carries `id`; guard the shape rather than trusting a duck type.
  return typeof tab?.id === 'string' && tab.id !== '' ? tab.id : undefined
}

/**
 * Read the three axis inputs separately.
 *
 * `currentPlace` joins them into one opaque key, which is exactly the wrong shape
 * for diagnosis: a key that never changes cannot say whether all three axes are
 * stuck or just the one being noticed. Reported alongside the key so a stuck axis
 * is identifiable instead of inferred.
 * @param ctx - client plugin context.
 * @returns the raw per-axis values.
 */
function placeParts(ctx) {
  const sessions = ctx.get('sessions')
  const layout = ctx.get('layout')
  const sessionId = mainSessionId(sessions)
  return {
    session: sessionId === undefined ? null : sessionId,
    panel: layout === undefined ? null : layoutPanel(layout),
    tab: focusedTab(ctx) ?? null,
  }
}

/**
 * Show one place, restoring as much of it as the services allow.
 * @param ctx - client plugin context.
 * @param key - the place to show.
 */
function restorePlace(ctx, key) {
  const { sessionId, panel, tabId } = parseKey(key)
  const uiWorkspace = ctx.get('uiWorkspace')
  const sessions = ctx.get('sessions')
  if (sessionId !== undefined && mainSessionId(sessions) !== sessionId) {
    // `openSession` is the same entry the workspace list uses, so it re-points the
    // main view without touching the right Sidebar's own session.
    if (uiWorkspace !== undefined) uiWorkspace.openSession(sessionId)
    else sessions?.open?.(sessionId)
  }
  const layout = ctx.get('layout')
  if (layout !== undefined && panel !== null) layout.selectPanel(panel)
  if (tabId !== undefined) ctx.get('sidebarRight')?.focus?.(tabId)
}

/**
 * Install the side-button history.
 * @param ctx - client plugin context.
 */
function apply(ctx) {
  // A thrown client half is invisible from outside the page: the module simply
  // never activates and nothing reaches the Host. Report the failure instead of
  // only rethrowing, so the console and the Host status route both see it.
  try {
    install(ctx)
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    window.dshNavButtonsError = message
    report({ loadedAt: Date.now(), error: message })
    throw error
  }
}

/**
 * Send this page half's counters to the Host's diagnostics route.
 * @param {object} payload - counters plus, on failure, the error message.
 */
function report(payload) {
  try {
    void fetch('/tool-nav-buttons/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Diagnostics must never break the feature.
  }
}

/**
 * Build the history and attach the listeners.
 * @param ctx - client plugin context.
 */
function install(ctx) {
  const history = new NavHistory(200)
  // While replaying a history step, observed navigation must not be recorded as
  // a new visit: that would turn every back step into a fresh branch.
  let replaying = false
  let visits = 0
  let backs = 0
  let forwards = 0
  // Diagnostics. `recordCalls` proves record() runs; `lastKeys` shows what the
  // place resolved to. Without them, "visits stayed at 1" is ambiguous between
  // "nothing moved" and "record never ran". Kept apart from the sampler below so
  // a 750 ms tick does not drown the signal an operator is looking for.
  let recordCalls = 0
  let sampleCalls = 0
  let lastKeys = []
  // Proof the interaction listener is attached and firing. Without these two, a
  // zero sample count is ambiguous between "not installed" and "nobody clicked".
  let listenersInstalled = 0
  let lastEvent = null
  // Per-observable firing counts; see the subscription site.
  const fired = {}
  // The raw per-axis inputs behind the last key. A key that never changes can mean
  // "one axis is stuck" or "the axes are all stuck together"; only the parts say
  // which, and the joined key hides them.
  let lastParts = null

  const record = (fromSample = false) => {
    if (replaying) return
    if (fromSample) sampleCalls++
    else recordCalls++
    lastParts = placeParts(ctx)
    const key = currentPlace(ctx)
    lastKeys.push(key === undefined ? null : key.slice(0, 60))
    if (lastKeys.length > 8) lastKeys.shift()
    if (key !== undefined && history.visit(key)) visits++
  }

  const step = (direction) => {
    const entry = direction === 'back' ? history.back() : history.forward()
    if (entry === undefined) return
    if (direction === 'back') backs++
    else forwards++
    replaying = true
    try {
      restorePlace(ctx, entry.key)
    } finally {
      // Selection changes settle asynchronously; release on the next task so the
      // observers see the restored place, not the restored place as a new visit.
      setTimeout(() => { replaying = false }, 0)
    }
  }

  const onPointer = (event) => {
    const direction = sideButton(event.button)
    if (direction === undefined) return
    // A page inside the sidebar browser owns its own history.
    if (ownsOwnHistory(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    step(direction)
  }

  ctx.effect(() => {
    // `auxclick` is the modern "non-primary button released" event and fires for
    // buttons 3/4 in Chromium; `mouseup` covers older embeddings that suppress it.
    const target = window
    target.addEventListener('auxclick', onPointer, true)
    target.addEventListener('mouseup', onPointer, true)
    // Chromium maps X1/X2 to browser back/forward on some platforms; suppress it
    // so the app decides instead of the embedder navigating away.
    const suppress = (event) => {
      if (sideButton(event.button) !== undefined && !ownsOwnHistory(event.target)) event.preventDefault()
    }
    target.addEventListener('mousedown', suppress, true)
    return () => {
      target.removeEventListener('auxclick', onPointer, true)
      target.removeEventListener('mouseup', onPointer, true)
      target.removeEventListener('mousedown', suppress, true)
    }
  }, 'dsh-nav-buttons: pointer')

  // Record on every settled selection change rather than polling. Two sources,
  // each the one that actually moves for its axis: `sessions.list` for a session
  // switch and `layout.panelInfo` for a main-panel switch.
  //
  // `sidebarRight.mounted` is NOT a tab source, despite its name: its contract is
  // explicitly "moves only when the on-screen Session changes; the Session's own
  // store commits are silent". Subscribing to it caught sidebar *session* changes
  // and never a tab switch, so the tab axis would still have missed every click.
  // The interface exposes no observable for the active tab, so that axis is
  // sampled below instead.
  ctx.effect(() => {
    record()
    const disposers = []
    // Counted per source: one total cannot say which observable is churning, and a
    // source that fires hundreds of times while the place never changes is the
    // difference between "quiet window" and "a subscription is looping".
    const sources = [
      ['list', ctx.get('sessions')?.list],
      ['panel', ctx.get('layout')?.panelInfo],
      ['mounted', ctx.get('sidebarRight')?.mounted],
    ]
    for (const [name, observable] of sources) {
      if (typeof observable?.subscribe !== 'function') continue
      disposers.push(observable.subscribe(() => {
        fired[name] = (fired[name] ?? 0) + 1
        record()
      }))
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-nav-buttons: record')

  // The active tab has no observable on the public sidebar face, so a tab switch
  // emits no event we can subscribe to. Record on the interactions that can cause
  // one instead: a tab switch IS a click, and a keyboard-driven one arrives right
  // after a key on the focused tab strip.
  //
  // A timer was tried first and is not enough: Chromium throttles background-tab
  // timers, and this document is usually backgrounded. Measured 1 tick in 10 s
  // against a 750 ms interval, so the tab axis would still have missed most
  // switches. Pointer events are not throttled.
  ctx.effect(() => {
    // Deferred one macrotask: the click that switches the tab is still travelling
    // through React when the pointer handler runs, so reading the place
    // synchronously would see the old one. `record()` ignores repeats anyway.
    const onPointer = (event) => {
      // Recorded so "the listener never ran" is distinguishable from "it ran and
      // found nothing new" — the counters alone cannot tell those apart.
      lastEvent = event.type
      setTimeout(() => record(true), 0)
    }
    const events = ['pointerdown', 'mouseup', 'keydown', 'focusin']
    for (const event of events) window.addEventListener(event, onPointer, true)
    listenersInstalled = events.length
    return () => {
      for (const event of events) window.removeEventListener(event, onPointer, true)
      listenersInstalled = 0
    }
  }, 'dsh-nav-buttons: sample on interaction')

  // A diagnostic handle for the operating console (`window.dshNavButtons`): the
  // service face is reachable only to other plugins, and the first thing an
  // operator wants is "did the half load, and what does the stack hold".
  const face = {
    back: () => step('back'),
    forward: () => step('forward'),
    get snapshot() { return history.snapshot },
  }
  window.dshNavButtons = face
  window.dshNavButtonsLoaded = true

  ctx.provide('navButtons', face)

  // Prove to the Host that this half actually ran: without this, a module that
  // never activates is indistinguishable from one that works but was not used.
  // `sources` names which observables the plugin could reach, so a dead axis is
  // visible as a missing name rather than as a feature that silently does nothing.
  const sources = {
    session: typeof ctx.get('sessions')?.list?.subscribe === 'function',
    panel: typeof ctx.get('layout')?.panelInfo?.subscribe === 'function',
    // The tab axis needs BOTH: `active()` to read the selection and `mounted`
    // to hear it change. Checking only `mounted` (as this did) reported the axis
    // healthy while `focusedTab()` was reading a member that does not exist.
    tab: typeof ctx.get('sidebarRight')?.active === 'function'
      && typeof ctx.get('sidebarRight')?.mounted?.subscribe === 'function',
    workspace: typeof ctx.get('uiWorkspace')?.openSession === 'function',
  }
  // Captured once: this is when the page half activated. Reporting `Date.now()`
  // on every event made the Host believe the page had just loaded whenever the
  // mouse moved, which hid genuinely stale pages.
  const activatedAt = Date.now()
  // Bumped whenever the reported shape changes. `set_plugin` reloads the host half
  // but does NOT re-execute a page that is already loaded, so the two halves can
  // legitimately disagree about the payload. Comparing this against the host's
  // expectation turns "the new field is mysteriously missing" into one glance.
  const SHAPE = 2
  const live = () => {
    const snapshot = history.snapshot
    report({
      shape: SHAPE,
      loadedAt: activatedAt,
      visits, backs, forwards,
      entries: snapshot.size,
      // The true cursor position, not a placeholder: `canGoBack`/`canGoForward`
      // and any future UI depend on where the stack actually stands.
      index: history.position,
      sources,
      // How often the observers fired and what they saw. A stuck `recordCalls`
      // means the subscriptions are dead; a growing one with an unchanging `key`
      // means the place simply is not moving.
      recordCalls,
      sampleCalls,
      listenersInstalled,
      lastEvent,
      fired,
      lastParts,
      // The stack itself, not the observation log. `entries: 2, index: 0` cannot
      // say whether that is two distinct places or one place recorded twice, and
      // only the contents answer whether a back/forward step has anywhere to go.
      stack: snapshot.keys.map(key => key.slice(0, 60)),
      lastKeys,
      current: snapshot.current === undefined ? null : snapshot.current.key,
    })
  }
  live()
  // Re-report on activity so the Host sees progress.
  for (const event of ['auxclick', 'mouseup']) window.addEventListener(event, live, true)

  // One timer, two jobs: report the current state, and drain the diagnostics
  // command mailbox that lets the navigation path be exercised without
  // synthesizing real mouse or keyboard input.
  //
  // These were two timers and both were unreliable, for the reason a 750 ms
  // sampler was abandoned earlier: Chromium throttles timers in a backgrounded
  // document, and this one is backgrounded whenever the operator is reading the
  // terminal instead of the app. Measured a 1 s drain being consumed only every
  // 16–24 s. One timer halves the loss and keeps the code honest about it; while
  // the window is actually in front, these run at full rate.
  //
  // Chained rather than overlapped: a fetch that outlives its interval must not
  // start stacking requests.
  ctx.effect(() => {
    let stopped = false
    let timer
    const tick = async () => {
      try {
        const response = await fetch('/tool-nav-buttons/command', { cache: 'no-store' })
        if (response.ok && !stopped) {
          const body = await response.json()
          if (typeof body?.command === 'string') {
            if (body.command === 'back') step('back')
            else if (body.command === 'forward') step('forward')
          }
        }
      } catch {
        // The route is absent in a profile without the host half; harmless.
      }
      if (stopped) return
      live()
      timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, 'dsh-nav-buttons: heartbeat and command drain')
}

return { inject: ['sidebarRight'], apply }
  },
})
