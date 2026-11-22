/**
 * Per-model quota memory and the fallback chain.
 *
 * Why this exists: AutoClaw bills each model against its own allowance, and a
 * model whose free allowance is gone answers `403 / 810000` on every request.
 * That is not a failure of the account or the plugin, but it reads like one —
 * "switch models and it works" is knowledge only a human who already tried has.
 * Two behaviours remove that trial-and-error:
 *
 * 1. `noteQuotaExhausted` remembers the model, so the picker can say so up
 *    front and a later request can go straight to a working model.
 * 2. `fallbackChain` decides which model to try next. Order is deliberate:
 *    the configured fallback first (Auto, the gateway's own router), then the
 *    rest of the catalog in its advertised order. Never the model that just
 *    failed, never one already known to be exhausted.
 *
 * This module is deliberately pure: no network, no timers, no state store. The
 * host owns persistence and hands the map in.
 *
 * @module dsh-connect-autoclaw/quota
 */

/** The gateway's code for "this model's allowance is spent". */
export const QUOTA_CODE = '810000'

/**
 * How long an exhaustion verdict is trusted.
 *
 * The gateway publishes no reset time, and quotas refill on a schedule nobody
 * here can read. A verdict is therefore a cache with a lifetime, not a fact:
 * six hours keeps the picker honest within a session and lets a same-day
 * refill start working again without anyone clearing state by hand.
 */
export const QUOTA_TTL_MS = 6 * 60 * 60 * 1000

/**
 * @typedef {{ at: number, code?: string, message?: string }} QuotaVerdict
 */

/**
 * Record an exhaustion verdict for a model.
 *
 * @param {Map<string, QuotaVerdict> | Record<string, QuotaVerdict>} store
 * @param {string} model
 * @param {{ at?: number, code?: string, message?: string }} [detail]
 */
export function noteQuotaExhausted(store, model, detail = {}) {
  if (typeof model !== 'string' || model === '') return
  const verdict = {
    at: Number.isFinite(detail.at) ? detail.at : Date.now(),
    ...(typeof detail.code === 'string' ? { code: detail.code } : {}),
    // Bounded: the gateway's sentence is long and this travels to the browser.
    ...(typeof detail.message === 'string' ? { message: detail.message.slice(0, 200) } : {}),
  }
  if (store instanceof Map) store.set(model, verdict)
  else store[model] = verdict
}

/**
 * Whether a model is currently known to be out of allowance.
 *
 * @param {Map<string, QuotaVerdict> | Record<string, QuotaVerdict>} store
 * @param {string} model
 * @param {number} [now]
 * @param {number} [ttlMs]
 */
export function isQuotaExhausted(store, model, now = Date.now(), ttlMs = QUOTA_TTL_MS) {
  const verdict = store instanceof Map ? store.get(model) : store?.[model]
  if (verdict === undefined || verdict === null || typeof verdict.at !== 'number') return false
  return now - verdict.at < ttlMs
}

/** Drop verdicts older than the TTL so the map cannot grow without bound. */
export function pruneQuota(store, now = Date.now(), ttlMs = QUOTA_TTL_MS) {
  const entries = store instanceof Map ? [...store.entries()] : Object.entries(store ?? {})
  for (const [model, verdict] of entries) {
    const fresh = verdict !== null && typeof verdict === 'object'
      && typeof verdict.at === 'number' && now - verdict.at < ttlMs
    if (fresh) continue
    if (store instanceof Map) store.delete(model)
    else delete store[model]
  }
}

/**
 * The ordered list of models to try for one request.
 *
 * @param {object} options
 * @param {string} options.model - what the caller asked for
 * @param {string[]} [options.catalog] - every advertised model id, in catalog order
 * @param {string} [options.preferred] - the configured fallback (Auto)
 * @param {Map<string, QuotaVerdict> | Record<string, QuotaVerdict>} [options.quota]
 * @param {boolean} [options.allowFallback] - false disables every hop after the first
 * @param {Set<string>|string[]} [options.demoted] - models on a rate/server
 *   cooldown (see model-health.js); skipped like an exhausted one
 * @param {number} [options.now]
 * @returns {string[]} at least the requested model, even when it is exhausted —
 *   a caller that turned fallback off must still get upstream's own answer
 */
export function fallbackChain({ model, catalog = [], preferred, quota, demoted, allowFallback = true, now = Date.now() }) {
  const demotedSet = demoted instanceof Set ? demoted : new Set(demoted ?? [])
  // A model is unavailable when its allowance is gone OR it is cooling down
  // from rate/server failures. Both mean "do not spend a request on it now".
  const unavailable = (candidate) => isQuotaExhausted(quota ?? {}, candidate, now) || demotedSet.has(candidate)
  const asked = typeof model === 'string' && model !== '' ? model : ''
  if (!allowFallback) return asked === '' ? [] : [asked]

  const seen = new Set()
  const chain = []
  const add = (candidate) => {
    if (typeof candidate !== 'string' || candidate === '' || seen.has(candidate)) return
    seen.add(candidate)
    chain.push(candidate)
  }

  // The configured fallback wins when the requested model cannot serve: Auto is
  // the gateway's own router and is the most likely thing to work next.
  if (asked !== '') {
    add(preferred !== undefined && preferred !== asked && !unavailable(preferred) ? preferred : undefined)
    add(asked)
  }
  for (const candidate of catalog) {
    if (unavailable(candidate)) continue
    add(candidate)
  }
  // A model that is the only option still gets its single attempt.
  if (chain.length === 0 && asked !== '') chain.push(asked)
  return chain
}

/**
 * The catalog rows the host hands the picker, annotated with what is known.
 *
 * The model NAME carries the verdict, because that is the one field the
 * picker's option builder reads (`label: model.name`). `quotaExhausted` is also
 * exposed as structured data, so the plugin's own card renders the same fact
 * without depending on that string.
 *
 * @param {Array<{id: string, name?: string}>} catalog
 * @param {object} options
 * @param {Map<string, QuotaVerdict> | Record<string, QuotaVerdict>} [options.quota]
 * @param {number} [options.now]
 * @param {(name: string) => string} [options.suffix] - decoration applied to an exhausted row's name
 */
export function annotateCatalog(catalog, {
  quota,
  demoted,
  now = Date.now(),
  suffix = (name) => `${name} · 额度已用完`,
  demotedSuffix = (name) => `${name} · 暂时不可用`,
} = {}) {
  if (!Array.isArray(catalog)) return []
  const demotedSet = demoted instanceof Set ? demoted : new Set(demoted ?? [])
  return catalog.map((row) => {
    if (row === null || typeof row !== 'object') return row
    const exhausted = isQuotaExhausted(quota ?? {}, row.id, now)
    // Exhausted (allowance gone) and demoted (cooling down) are different facts
    // with different fixes, so they keep different labels.
    const cooling = !exhausted && demotedSet.has(row.id)
    const name = typeof row.name === 'string' && row.name !== '' ? row.name : row.id
    return {
      ...row,
      // Always materialize `name`: the picker's label is `model.name`, and a
      // row without one would render as an empty line.
      name: exhausted ? suffix(name) : cooling ? demotedSuffix(name) : name,
      quotaExhausted: exhausted,
      modelDemoted: cooling,
    }
  })
}
