/**
 * Per-model health: temporarily demote a model that keeps failing.
 *
 * ## The gap this closes
 *
 * `quota` (810000) already benches a model outright — its allowance is gone and
 * no amount of retrying changes that. But `rate` (429 / 810002) and `server`
 * (5xx) are different: the model may be fine again in seconds, yet with a single
 * account the shim's three attempts all hit the same sick upstream and the caller
 * pays three timeouts to learn what the first one already proved.
 *
 * So a 429/5xx does not ban the model. It counts. Past `threshold` consecutive
 * failures the model is demoted for a backoff window that doubles each time, so
 * a brief hiccup costs one turn and a persistent outage stops being retried at
 * full price. A success clears the record immediately.
 *
 * ## Why consecutive, not windowed
 *
 * A window ("3 failures in 60 s") keeps failing a model that is merely used
 * rarely even after it recovered, because the old failures stay in the window.
 * A consecutive counter resets on the first success, which is the moment we
 * actually have new information.
 *
 * This module is pure: no timers, no storage. `index.js` owns persistence.
 *
 * @module dsh-connect-autoclaw/model-health
 */

/** Failures in a row before a model is demoted. */
export const DEFAULT_FAILURE_THRESHOLD = 2

/** First demotion window; doubles on each further failure up to the cap. */
export const DEFAULT_COOLDOWN_MS = 60_000

/** Upper bound on the backoff, so a model never disappears for a whole session. */
export const DEFAULT_MAX_COOLDOWN_MS = 15 * 60 * 1000

/** Which failure classes say something about the MODEL rather than the request. */
const DEMOTING_KINDS = new Set(['rate', 'server'])

/**
 * @typedef {{ failures: number, until: number, at: number, kind: string }} ModelHealth
 */

/**
 * Record one outcome for a model.
 *
 * @param {Record<string, ModelHealth>} store - mutated in place
 * @param {string} model
 * @param {{ kind?: string, at?: number }} outcome
 * @param {{ threshold?: number, cooldownMs?: number, maxCooldownMs?: number }} [options]
 * @returns {{ demoted: boolean, until: number, failures: number }}
 */
export function noteModelOutcome(store, model, outcome = {}, options = {}) {
  const threshold = Number.isSafeInteger(options.threshold) && options.threshold >= 1
    ? options.threshold
    : DEFAULT_FAILURE_THRESHOLD
  const cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs > 0
    ? options.cooldownMs
    : DEFAULT_COOLDOWN_MS
  const maxCooldownMs = Number.isFinite(options.maxCooldownMs) && options.maxCooldownMs > 0
    ? options.maxCooldownMs
    : DEFAULT_MAX_COOLDOWN_MS
  const at = Number.isFinite(outcome.at) ? outcome.at : Date.now()

  if (typeof model !== 'string' || model === '') return { demoted: false, until: 0, failures: 0 }

  const kind = typeof outcome.kind === 'string' ? outcome.kind : ''

  // A success is the only evidence that clears the record. Anything that says
  // nothing about the model (a bad request body, a caller abort) is ignored
  // rather than counted — otherwise a client bug would demote a healthy model.
  if (kind === 'ok') {
    delete store[model]
    return { demoted: false, until: 0, failures: 0 }
  }
  if (!DEMOTING_KINDS.has(kind)) {
    const existing = store[model]
    return { demoted: false, until: 0, failures: existing?.failures ?? 0 }
  }

  const previous = store[model]
  const failures = (previous?.failures ?? 0) + 1
  if (failures < threshold) {
    store[model] = { failures, until: 0, at, kind }
    return { demoted: false, until: 0, failures }
  }

  // Exponential backoff from the threshold onward: 1x, 2x, 4x … capped.
  const over = failures - threshold
  const window = Math.min(cooldownMs * 2 ** over, maxCooldownMs)
  const until = at + window
  store[model] = { failures, until, at, kind }
  return { demoted: true, until, failures }
}

/**
 * Whether a model is currently demoted.
 *
 * @param {Record<string, ModelHealth>} store
 * @param {string} model
 * @param {number} [now]
 */
export function isModelDemoted(store, model, now = Date.now()) {
  const entry = store?.[model]
  if (entry === undefined || entry === null) return false
  return Number.isFinite(entry.until) && entry.until > now
}

/** Drop records whose demotion expired and that carry no live failure streak. */
export function pruneModelHealth(store, now = Date.now()) {
  for (const [model, entry] of Object.entries(store ?? {})) {
    if (entry === null || typeof entry !== 'object') { delete store[model]; continue }
    const stillCooling = Number.isFinite(entry.until) && entry.until > now
    if (stillCooling) continue
    // The streak outlives the window on purpose: the next failure should resume
    // the backoff ladder instead of starting over at 1x.
    if (Number.isFinite(entry.failures) && entry.failures > 0) continue
    delete store[model]
  }
}

/**
 * Every model currently demoted, for diagnostics and for the selection chain.
 *
 * @param {Record<string, ModelHealth>} store
 * @param {number} [now]
 * @returns {string[]}
 */
export function demotedModels(store, now = Date.now()) {
  return Object.entries(store ?? {})
    .filter(([, entry]) => entry !== null && typeof entry === 'object'
      && Number.isFinite(entry.until) && entry.until > now)
    .map(([model]) => model)
}
