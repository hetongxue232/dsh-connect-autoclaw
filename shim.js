/**
 * The loopback shim: the only component that talks to AutoClaw's gateway.
 *
 * Data flow (the pattern `dsh-connect-zhipu` established):
 *
 * ```
 * DSH PiAiAdapter (route `atuoclaw`)
 *   -> this shim (random port on 127.0.0.1 + per-process random secret)
 *   -> https://autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions
 * ```
 *
 * pi-ai authenticates to the shim with the per-process random secret as its
 * OpenAI apiKey; the shim validates it in constant time, then rewrites the
 * request into the shape AutoClaw's own client sends and forwards it. The
 * secret never leaves this process; the account token never leaves the host
 * except to the vendor gateway.
 *
 * ## What the upstream demands (measured 2026-11-13 on a live account)
 *
 * Three things, each of which is a bare `406` with an empty body when missing:
 *
 *   1. A `system` message whose text **contains**
 *      `You are AutoClaw. Answer the user directly and concisely.`
 *      The match is containment, not a prefix, and only `system` messages are
 *      scanned — the same phrase in a `user` turn is accepted.
 *   2. No client-supplied `max_tokens` / `max_completion_tokens`.
 *   3. No foreign harness identity phrase in that system text
 *      (`you are claude code`, `you are codex`, `claude agent sdk`,
 *      `you are an interactive agent in traecode`).
 *
 * Anything else about the headers is negotiable: the gateway answers a bare
 * 406 only for those three, and 400 `非法模型` for an unknown model id.
 *
 * The upstream speaks plain OpenAI Chat Completions, so this module is a
 * translator, not a protocol reimplementation.
 *
 * @module dsh-connect-autoclaw/shim
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createAccountLimiter } from './ratelimit.js'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { readCredential } from './credential.js'
import { QUOTA_CODE } from './quota.js'
import { signedHeaders as upstreamSignedHeaders } from './upstream.js'

/** The literal the upstream's system-prompt allowlist matches on. */
export const REQUIRED_BANNER = 'You are AutoClaw. Answer the user directly and concisely.'

/**
 * System-text fragments the upstream's denylist rejects with the same bare 406.
 *
 * Measured on a live account: each of these flips a 200 into a 406 when placed
 * in the system message, while `You are Cursor`, `You are Cline`,
 * `You are Windsurf`, `You are ChatGPT` and `You are DeepSeek Harness` all pass.
 * The list is the observed set, not the vendor's documented one — extend it if
 * the gateway grows.
 */
export const FOREIGN_IDENTITY_PHRASES = Object.freeze([
  'you are claude code',
  'you are codex',
  'claude agent sdk',
  'you are an interactive agent in traecode',
])

/** What a neutralised phrase becomes: a brand swap keeps the sentence grammatical. */
const IDENTITY_REPLACEMENTS = Object.freeze({
  'you are claude code': 'you are AutoClaw',
  'you are codex': 'you are AutoClaw',
  'claude agent sdk': 'AutoClaw SDK',
  'you are an interactive agent in traecode': 'you are an interactive agent in AutoClaw',
})

/** AutoClaw's own client identity, from its shipped bundle. */
export const CLIENT = Object.freeze({
  appId: '100003',
  appKey: '38d2391985e2369a5fb8227d8e6cd5e5',
  product: 'autoclaw',
  channel: 'official',
  version: '2.0.3',
})

/** Ports `fetch` refuses to dial; `listen(0)` occasionally lands on one. */
const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 77, 79, 87, 95, 101, 102, 103, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])
const PORT_ROLL_LIMIT = 5

/** Guard against a runaway client body before any upstream call. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Whether a Host header names this machine. A DNS-rebinding page cannot forge it. */
export function hostIsLoopback(host) {
  if (typeof host !== 'string' || host === '') return false
  const lowered = host.toLowerCase()
  const bare = lowered.startsWith('[') ? lowered.slice(1, lowered.indexOf(']')) : lowered.split(':')[0]
  if (LOOPBACK_HOSTS.has(bare)) return true
  if (isIP(bare) === 4) return bare.startsWith('127.')
  if (isIP(bare) === 6) return bare === '::1' || bare === '0:0:0:0:0:0:0:1'
  return false
}

/** The signed header set AutoClaw's own client sends (delegates to upstream.js). */
export function signedHeaders(token, options = {}) {
  return upstreamSignedHeaders({
    token: typeof token === 'string' ? token : '',
    version: options.version ?? CLIENT.version,
    timestamp: options.now ?? Date.now(),
  })
}

/**
 * Turn a system string the upstream would refuse into one it accepts.
 *
 * Three steps, in escalating order; the FIRST one that changes anything wins,
 * and a string that already passes is returned byte-identical.
 */
export function neutralizeSystem(text) {
  if (typeof text !== 'string' || text.trim() === '') return REQUIRED_BANNER
  let next = text
  // Recompute the haystack every pass: each replacement changes length, so a
  // lowercase copy taken once would search a stale offset and slice the wrong
  // span (with two or more phrases the text came out mangled).
  for (const phrase of FOREIGN_IDENTITY_PHRASES) {
    let lowered = next.toLowerCase()
    let at = lowered.indexOf(phrase)
    while (at !== -1) {
      const replacement = IDENTITY_REPLACEMENTS[phrase] ?? 'auto claw'
      next = next.slice(0, at) + replacement + next.slice(at + phrase.length)
      lowered = next.toLowerCase()
      // Resume past the replacement so a phrase inside it cannot loop forever.
      at = lowered.indexOf(phrase, at + replacement.length)
    }
  }
  if (!next.includes(REQUIRED_BANNER)) next = `${REQUIRED_BANNER}\n\n${next}`
  return next
}

/**
 * Rewrite an OpenAI chat body into AutoClaw's accepted shape.
 *
 * `max_tokens` / `max_completion_tokens` are dropped rather than clamped: the
 * upstream refuses the field itself, and the native client lets each model run
 * to its own cap.
 */
export function translateRequest(body) {
  const out = { ...body }
  delete out.max_tokens
  delete out.max_completion_tokens
  const messages = Array.isArray(out.messages) ? out.messages : []
  let sawSystem = false
  const rewritten = messages.map((message) => {
    if (message === null || typeof message !== 'object') return message
    if (message.role !== 'system' && message.role !== 'developer') return message
    sawSystem = true
    return { ...message, role: 'system', content: neutralizeSystem(
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
          : '',
    ) }
  })
  // No system message at all is the most common 406: pi-ai only sends one when
  // the harness has prompt text to prepend, and a bare user turn has none.
  if (!sawSystem) rewritten.unshift({ role: 'system', content: REQUIRED_BANNER })
  out.messages = rewritten
  return out
}

/**
 * Classify an upstream failure into "switch accounts" vs "the request itself
 * is broken". Borrowed from `dsh-connect-workbuddy`'s doctrine — business
 * code first, HTTP status second:
 *
 *   failoverable   — 401 / 401001 / 410000 (credential rejected), 810000
 *                    (this account's quota is gone), 810002 (this account is
 *                    throttled), 5xx, network. Another account can serve.
 *   NOT failoverable — 400 `非法模型`, 406 prompt gate. The same body fails
 *                    identically under every account; switching only burns a
 *                    real request and falsely benches a healthy credential.
 */
export function classifyFailure(status, body) {
  const text = typeof body === 'string' ? body : ''
  const codeMatch = /"code"\s*:\s*(\d+)/.exec(text)
  const code = codeMatch === null ? undefined : Number(codeMatch[1])
  if (code === 401001 || code === 410000) return 'credential'
  if (code === 810000) return 'quota'
  if (code === 810002) return 'rate'
  if (status === 401) return 'credential'
  if (status >= 500) return 'server'
  return 'request'
}

/** Whether this failure class is worth trying under another account. */
export function isFailoverable(kind) {
  return kind === 'credential' || kind === 'quota' || kind === 'rate' || kind === 'server'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** An OpenAI-shaped error body, keeping the vendor's own message. */
function sendOpenAiError(res, status, type, message, code) {
  sendJson(res, status, {
    error: { message, type, ...(code === undefined ? {} : { code }) },
  })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Create and start the shim.
 *
 * @param options.baseURL - AutoClaw gateway origin.
 * @param options.accountRoot - accounts directory override.
 * @param options.logger - optional Cordis logger.
 */
export function createShim(options = {}) {
  const base = (options.baseURL ?? 'https://autoglm-api.zhipuai.cn').replace(/\/+$/, '')
  const secret = randomBytes(32).toString('base64url')
  // One request per account at a time. Callers may inject a limiter (e.g. the
  // host shares it with the probe route); otherwise own a private one.
  const limiter = options.limiter ?? createAccountLimiter()
  let server
  let port = 0
  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })

  const listenOnce = (attempt) => {
    const candidate = createServer((req, res) => { void handle(req, res) })
    server = candidate
    candidate.once('error', (error) => {
      options.logger?.warn(`dsh-connect-autoclaw: shim error: ${String(error)}`)
    })
    candidate.listen(0, '127.0.0.1', () => {
      const address = candidate.address()
      const bound = typeof address === 'object' && address !== null ? address.port : undefined
      if (bound === undefined || BAD_PORTS.has(bound)) {
        candidate.close()
        if (attempt + 1 >= PORT_ROLL_LIMIT) throw new Error('could not bind a usable loopback port')
        listenOnce(attempt + 1)
        return
      }
      port = bound
      resolveReady()
    })
  }
  listenOnce(0)

  async function handle(req, res) {
    // A browser page elsewhere must not be able to reach this shim even though
    // it can reach 127.0.0.1: the Host header check defeats DNS rebinding, and
    // the bearer check defeats a same-machine process that guesses the port.
    if (!hostIsLoopback(req.headers.host)) {
      sendOpenAiError(res, 403, 'forbidden', 'Host is not loopback')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    // The bearer check comes FIRST, before any route: this server holds a live
    // account token, so an unauthenticated route is an unauthenticated hole even
    // when it "only" lists model ids.
    const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const expected = Buffer.from(secret)
    const actual = Buffer.from(presented)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      sendOpenAiError(res, 401, 'authentication_error', 'Bad shim secret')
      return
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      sendJson(res, 200, { object: 'list', data: options.listModels?.() ?? [] })
      return
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      sendOpenAiError(res, 404, 'not_found', `No route for ${req.method} ${url.pathname}`)
      return
    }

    let body
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw.length === 0 ? '{}' : raw.toString('utf8'))
    } catch (error) {
      sendOpenAiError(res, 400, 'invalid_request_error', `Body was not JSON: ${String(error)}`)
      return
    }

    // MODEL FALLBACK. A model whose allowance is spent answers 403/810000 on
    // every request, so a same-account retry is pointless — the model itself
    // has to change. The chain is decided once, before any attempt, and each
    // quota rejection advances it. `translations` keeps one rewritten body per
    // model so the wire body always names the model actually being called.
    let fallbackIndex = 0
    let translated = translateRequest(body)
    const isStream = body.stream === true
    const controller = new AbortController()
    req.once('close', () => controller.abort())

    // THE FAILOVER LOOP (the account-pool analogue of dsh-connect-workbuddy's
    // shim). Attempts are capped; a failure class the pool cannot fix reports
    // upstream's own answer verbatim instead of burning accounts on it. Once
    // 200 headers are committed the answer streams as-is — retrying after
    // that would concatenate two answers.
    const MAX_ATTEMPTS = 3
    const tried = []
    // A credential-class answer (401 / 401001 / 410000) does not prove the
    // account is unusable — the gateway also revokes tokens out of band, and
    // the local `exp` claim never moves when it does. Retrying the SAME
    // account once with a force-refreshed token separates "expired" from "no
    // account left", which the plain failover loop below cannot do.
    let refreshedFor = undefined // accountId already force-refreshed this request
    let pinned = undefined // credential carrying the refreshed token
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let credential
      try {
        credential = pinned !== undefined
          ? pinned
          : options.getAccount !== undefined
            ? await options.getAccount({ exclude: [...tried] })
            : await readCredential({ accountRoot: options.accountRoot ?? '' })
      } catch (error) {
        sendOpenAiError(res, 401, 'authentication_error', `AutoClaw credential unavailable: ${String(error?.message ?? error)}`)
        return
      }
      if (credential === undefined || typeof credential.accessToken !== 'string' || credential.accessToken === '') {
        sendOpenAiError(res, 401, 'authentication_error', tried.length === 0
          ? 'no AutoClaw account is available (install the app and sign in, or import one)'
          : `no further AutoClaw account after ${tried.length} failure(s): ${tried.join(', ')}`)
        return
      }
      if (pinned === undefined) tried.push(credential.accountId)
      pinned = undefined

      // Hold this account's slot until the whole response is on the wire. The
      // `finally` releases on every exit (including `continue` and stream end),
      // so the next caller cannot pile onto a busy credential.
      const release = await limiter.acquire(credential.accountId)
      try {
        let upstream
        try {
          upstream = await fetch(`${base}/autoclaw-proxy/proxy/autoclaw/chat/completions`, {
            method: 'POST',
            headers: {
              ...signedHeaders(credential.accessToken),
              'content-type': 'application/json',
              'X-Authorization': /^Bearer\s+/i.test(credential.accessToken)
                ? credential.accessToken
                : `Bearer ${credential.accessToken}`,
              'X-Request-Model': translated.model,
              'X-Client-Type': 'pc',
              'X-Agent-Id': 'main',
              'X-Trace-Id': randomUUID(),
              'x_trace_id': 'autoclaw-desktop',
              Accept: isStream ? 'text/event-stream' : 'application/json',
            },
            body: JSON.stringify(translated),
            signal: controller.signal,
          })
        } catch (error) {
          if (controller.signal.aborted) {
            if (!res.destroyed) res.destroy()
            return
          }
          // A transport failure says nothing about the request body and is
          // failoverable: the next account may sit behind a healthier path.
          options.onAccountOutcome?.(credential.accountId, {
            kind: 'network', status: 0, message: String(error?.message ?? error),
          })
          if (attempt + 1 >= MAX_ATTEMPTS) {
            sendOpenAiError(res, 502, 'upstream_error', `AutoClaw transport failed: ${String(error?.message ?? error)}`)
            return
          }
          continue
        }

        if (upstream.ok) {
          options.onAccountOutcome?.(credential.accountId, { kind: 'ok', status: 200 })
          res.writeHead(200, {
            'content-type': upstream.headers.get('content-type') ?? (isStream ? 'text/event-stream' : 'application/json'),
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            ...(upstream.headers.get('x-request-id') === null ? {} : { 'x-request-id': upstream.headers.get('x-request-id') }),
          })
          if (upstream.body === null) {
            res.end()
            return
          }
          await new Promise((resolve) => {
            const stream = Readable.fromWeb(upstream.body)
            stream.on('error', () => { if (!res.destroyed) res.destroy(); resolve() })
            stream.on('end', resolve)
            stream.pipe(res)
          })
          return
        }

        const text = await upstream.text().catch(() => '')
        const kind = classifyFailure(upstream.status, text)
        options.onAccountOutcome?.(credential.accountId, {
          kind, status: upstream.status, message: text.slice(0, 200),
        })

        // THIS MODEL is out of allowance (not this account). Remember it so the
        // picker can warn, then try the next model instead of re-sending the
        // same hopeless request to another account.
        if (kind === 'quota') {
          const attemptModel = translated.model
          options.onQuotaExhausted?.(attemptModel, {
            code: QUOTA_CODE,
            message: text.slice(0, 200),
          })
          const next = options.nextFallback?.(attemptModel)
          if (typeof next === 'string' && next !== '' && next !== attemptModel) {
            translated = translateRequest({ ...body, model: next })
            // A different model is a different request, not another attempt at
            // the same one: it gets its own slice of the attempt budget.
            attempt = -1
            continue
          }
        }
        // Credential rejected: try once more with a force-refreshed token
        // before writing the account off. Only one such retry per request, and
        // only while attempts remain.
        if (kind === 'credential' && refreshedFor !== credential.accountId
            && attempt + 1 < MAX_ATTEMPTS && typeof options.forceRefresh === 'function') {
          refreshedFor = credential.accountId
          const next = await options.forceRefresh(credential).catch(() => undefined)
          if (next !== undefined && typeof next.accessToken === 'string'
              && next.accessToken !== '' && next.accessToken !== credential.accessToken) {
            pinned = next
            continue
          }
        }

        if (!isFailoverable(kind) || attempt + 1 >= MAX_ATTEMPTS) {
          const hint = upstream.status === 406
            ? '（406 空 body = 系统提示词没过上游白名单；shim 已尽力改写，说明网关加了新规则）'
            : kind === 'quota'
              // The gateway names the model's plan, not the cause: a long
              // Chinese sentence on a model that simply ran out of its free
              // allowance. Naming the model and the way out is the difference
              // between "the plugin is broken" and "switch models or top up".
              ? `（${translated.model} 的额度已用完，自动回退也没有可用模型——换一个模型，或为该模型开通会员；这不是插件故障）`
              : ''
          sendOpenAiError(res, upstream.status, upstream.status === 406 ? 'prompt_gate' : 'upstream_error', `${hint}${text}`.trim() || `HTTP ${upstream.status}`)
          return
        }
        // Failoverable: the loop picks the next account (the pool excludes `tried`).
      } finally {
        release()
      }
    }
  }

  return {
    ready,
    baseUrl: () => `http://127.0.0.1:${port}`,
    token: () => secret,
    close: () => new Promise((resolve) => {
      if (server === undefined) { resolve(); return }
      server.closeAllConnections?.()
      server.close(() => { resolve() })
    }),
  }
}
