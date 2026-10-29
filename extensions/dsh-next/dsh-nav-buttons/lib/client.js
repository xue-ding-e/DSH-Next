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
 * Read the focused sidebar tab, if the surface exposes one.
 * @param ctx - client plugin context.
 * @returns the tab id or undefined.
 */
function focusedTab(ctx) {
  const sidebarRight = ctx.get('sidebarRight')
  const state = sidebarRight?.state?.getSnapshot?.() ?? sidebarRight?.getSnapshot?.()
  const layout = state?.layout
  if (layout === undefined || layout === null) return undefined
  for (const [paneId, pane] of Object.entries(layout.panes ?? {})) {
    if (typeof pane?.activeTabId === 'string' && pane.activeTabId !== '') return pane.activeTabId
    void paneId
  }
  return typeof layout.activeTabId === 'string' && layout.activeTabId !== ''
    ? layout.activeTabId
    : undefined
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

  const record = () => {
    if (replaying) return
    const key = currentPlace(ctx)
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

  // Record on every settled selection change rather than polling. Three sources,
  // each the one that actually moves for its axis: `sessions.list` for a session
  // switch, `layout.panelInfo` for a main-panel switch, `sidebarRight.mounted`
  // for a sidebar-tab switch.
  ctx.effect(() => {
    record()
    const disposers = []
    const observables = [
      ctx.get('sessions')?.list,
      ctx.get('layout')?.panelInfo,
      ctx.get('sidebarRight')?.mounted,
    ]
    for (const observable of observables) {
      if (typeof observable?.subscribe === 'function') disposers.push(observable.subscribe(record))
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-nav-buttons: record')

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
    tab: typeof ctx.get('sidebarRight')?.mounted?.subscribe === 'function',
    workspace: typeof ctx.get('uiWorkspace')?.openSession === 'function',
  }
  // Captured once: this is when the page half activated. Reporting `Date.now()`
  // on every event made the Host believe the page had just loaded whenever the
  // mouse moved, which hid genuinely stale pages.
  const activatedAt = Date.now()
  const live = () => {
    const snapshot = history.snapshot
    report({
      loadedAt: activatedAt,
      visits, backs, forwards,
      entries: snapshot.size,
      // The true cursor position, not a placeholder: `canGoBack`/`canGoForward`
      // and any future UI depend on where the stack actually stands.
      index: history.position,
      sources,
      current: snapshot.current === undefined ? null : snapshot.current.key,
    })
  }
  live()
  // Re-report on activity so the Host sees progress without a polling timer.
  for (const event of ['auxclick', 'mouseup']) window.addEventListener(event, live, true)
}

return { inject: ['sidebarRight'], apply }
  },
})
