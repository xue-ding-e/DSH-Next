/**
 * Host half of the navigation-buttons plugin.
 *
 * The feature itself lives in the browser: it listens for pointer side buttons
 * and walks a history of the places this window has shown. This half exists for
 * one reason — evidence. A client plugin that never activates is invisible from
 * outside the page (its module simply never runs), so the browser half reports
 * its own liveness here and the operator can ask over plain HTTP.
 *
 * `GET /tool-nav-buttons/status` returns what the page last reported. It reads
 * counters only: no session titles, no URLs, nothing about where the user went.
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-nav-buttons'

/** Route prefix owned by this plugin; the browser half posts to it. */
const ROUTE = '/tool-nav-buttons'

/**
 * The browser half's self-report. `loadedAt` proves the module executed; the
 * counters prove the listeners fire; `entries`/`index` show the history moving.
 * @typedef {object} PageReport
 * @property {number} loadedAt Epoch ms when the page half's apply() ran.
 * @property {number} visits Recorded places so far.
 * @property {number} backs Back steps taken.
 * @property {number} forwards Forward steps taken.
 * @property {number} entries Entries currently retained.
 * @property {number} index Current position in the stack.
 */

/** Latest report from the page; undefined until the browser half posts one. */
let report

/** When the last report arrived, so a stale page is distinguishable from none. */
let reportedAt

/** Inert host body: no tools, one diagnostics route. */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://nav-buttons.invalid')
      const endpoint = url.pathname.slice(ROUTE.length + 1)

      if (endpoint === 'status' && req.method === 'GET') {
        // "never reported" alone is misleading: after THIS host half reloads its
        // module state is empty, so a perfectly healthy page looks identical to
        // a page that never loaded until it next reports. Say which one it is.
        const body = JSON.stringify(report === undefined
          ? {
            pageHalf: 'awaiting first report',
            route: ROUTE,
            note: 'No report since this host half started. Reload the page, then wait up to 20s '
              + '(the page reports on a heartbeat) or move the mouse once.',
          }
          : { pageHalf: 'reported', ageMs: Date.now() - reportedAt, ...report })
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(body)
        return
      }

      if (endpoint === 'report' && req.method === 'POST') {
        // The body is a small JSON object; buffering it keeps this handler free of
        // stream bookkeeping for what is a diagnostics ping.
        const chunks = []
        req.on('data', chunk => { chunks.push(chunk) })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            report = {
              loadedAt: Number(parsed.loadedAt) || 0,
              visits: Number(parsed.visits) || 0,
              backs: Number(parsed.backs) || 0,
              forwards: Number(parsed.forwards) || 0,
              entries: Number(parsed.entries) || 0,
              index: Number(parsed.index) || 0,
              // Which observables the page half could actually reach. A missing
              // axis means that part of the feature is inert, which is otherwise
              // invisible from outside the page.
              sources: parsed.sources ?? null,
              // The place key the history currently holds: session/panel/tab,
              // separated by U+0001. Diagnostics only — it carries ids, not text.
              current: typeof parsed.current === 'string' ? parsed.current : null,
              // Proves whether the page half's observers actually fire, and what
              // they resolved to. Distinguishes "nothing moved" from "record is
              // dead", which look identical in the counters alone.
              recordCalls: Number(parsed.recordCalls) || 0,
              sampleCalls: Number(parsed.sampleCalls) || 0,
              listenersInstalled: Number(parsed.listenersInstalled) || 0,
              lastEvent: typeof parsed.lastEvent === 'string' ? parsed.lastEvent : null,
              lastParts: parsed.lastParts !== null && typeof parsed.lastParts === 'object' ? parsed.lastParts : null,
              lastKeys: Array.isArray(parsed.lastKeys) ? parsed.lastKeys.slice(-8) : [],
            }
            reportedAt = Date.now()
            res.writeHead(204).end()
          } catch {
            res.writeHead(400).end('bad report')
          }
        })
        return
      }

      res.writeHead(404).end()
    },
  }), 'dsh-nav-buttons: diagnostics route')
}

export default { name, inject: ['webServer'], apply }
