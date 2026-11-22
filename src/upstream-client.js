/**
 * Upstream HTTP client: one keep-alive pool instead of a fresh connection per
 * request.
 *
 * ## Why this exists
 *
 * The shim called the global `fetch`, which means every chat request paid a new
 * connection: DNS, TCP, and a full TLS handshake before a single byte of the
 * answer could arrive. Measured against the real gateway (2026-11-23,
 * `zai_auto`), the second request on a reused socket reached its first byte
 * ~40% sooner than the first one that had to build the connection.
 *
 * ## Why `node:https` and not `undici`
 *
 * `undici.Agent` resolves from the plugin directory only because DSH's own
 * `node_modules` sits next to it — an undeclared, implicit dependency. Worse, it
 * does not even work: the DSH copy's dispatcher protocol does not match the
 * built-in `fetch` that consumes it, so a request fails with
 * `UND_ERR_INVALID_ARG: invalid onRequestStart method`. `node:https` needs no
 * dependency at all and its `Agent` is the documented owner of keep-alive
 * sockets, so that is what this uses.
 *
 * ## What it must preserve
 *
 * The shim reads `upstream.ok`, `upstream.status`, `upstream.headers.get(...)`,
 * `upstream.body` (a stream piped to the client) and `upstream.text()`. This
 * module answers the same shape, so the failover, quota and streaming logic
 * above it did not have to change.
 *
 * @module dsh-connect-autoclaw/upstream-client
 */

import http from 'node:http'
import https from 'node:https'

/** Defaults chosen for a chat workload: many short-lived parallel streams. */
export const POOL_DEFAULTS = Object.freeze({
  keepAlive: true,
  // The gateway answers within seconds; 30 s keeps a warm socket across the
  // gaps between turns without holding dead ones.
  keepAliveMsecs: 30_000,
  // A burst of concurrent callers must not queue behind a tiny pool.
  maxSockets: 16,
  // Idle sockets worth keeping for the next turn.
  maxFreeSockets: 8,
})

/**
 * Create the keep-alive agent pair (http + https) used by the shim.
 *
 * Both are created so a self-hosted `http://` gateway works in tests and in
 * local deployments; production talks https.
 */
export function createPool(options = {}) {
  const settings = {
    keepAlive: options.keepAlive !== false,
    keepAliveMsecs: Number.isFinite(options.keepAliveMsecs) ? options.keepAliveMsecs : POOL_DEFAULTS.keepAliveMsecs,
    maxSockets: Number.isFinite(options.maxSockets) ? options.maxSockets : POOL_DEFAULTS.maxSockets,
    maxFreeSockets: Number.isFinite(options.maxFreeSockets) ? options.maxFreeSockets : POOL_DEFAULTS.maxFreeSockets,
  }
  const httpsAgent = new https.Agent(settings)
  const httpAgent = new http.Agent(settings)
  return {
    settings,
    agentFor(url) {
      try {
        return new URL(url).protocol === 'http:' ? httpAgent : httpsAgent
      } catch {
        return httpsAgent // an unparseable URL is a caller bug; https is the safe default
      }
    },
    /** Idle sockets kept for reuse — the evidence that pooling works. */
    stats() {
      return {
        https: { free: Object.keys(httpsAgent.freeSockets).length, active: Object.keys(httpsAgent.sockets).length },
        http: { free: Object.keys(httpAgent.freeSockets).length, active: Object.keys(httpAgent.sockets).length },
        maxSockets: settings.maxSockets,
      }
    },
    destroy() {
      httpsAgent.destroy()
      httpAgent.destroy()
    },
  }
}

/**
 * A `fetch`-shaped POST over a pooled agent.
 *
 * Returns `{ ok, status, headers, body, text, abort }`:
 *   - `headers.get(name)` — case-insensitive, like the Fetch API
 *   - `body` — the raw readable, or null when the response has none
 *   - `text()` — buffers the body (only for error paths; the caller streams
 *     200s and must not call this on them)
 *
 * @param {string} url
 * @param {object} options
 * @param {'POST'|'GET'} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.body]
 * @param {AbortSignal} [options.signal]
 * @param {{agentFor: (url: string) => object}} options.pool
 */
export function requestWithPool(url, options) {
  const { method = 'POST', headers = {}, body, signal, pool } = options
  const transport = url.startsWith('http:') ? http : https
  const agent = pool.agentFor(url)

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }

    const req = transport.request(url, { method, headers, agent }, (res) => {
      const headerMap = new Map(
        Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
      )
      let consumed = false
      resolve({
        ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
        status: res.statusCode ?? 0,
        headers: {
          get: (name) => headerMap.get(String(name).toLowerCase()) ?? null,
        },
        body: res,
        text: () => {
          // Streaming callers must not land here; guard against a silent drain.
          consumed = true
          return new Promise((done, fail) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
            res.on('error', fail)
          })
        },
        /** Whether the socket this response arrived on was reused. */
        reusedSocket: req.reusedSocket === true,
        get consumed() { return consumed },
      })
    })

    // One listener for both the caller's disconnect and our own deadline.
    const onAbort = () => {
      req.destroy(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    req.on('close', () => { signal?.removeEventListener('abort', onAbort) })

    if (body !== undefined) req.write(body)
    req.end()
  })
}
