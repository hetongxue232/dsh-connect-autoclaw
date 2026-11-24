/**
 * AutoClaw (智谱 zwork) integration for DSH: a model provider AND a readout.
 *
 * ## What changed from 1.x
 *
 * 1.0.0 shipped the points readout only, because the chat endpoint answered a
 * bare `406` to every request it could construct. That 406 was never a header
 * problem: AutoClaw's gateway allowlists the **system prompt**. A request
 * whose `system` message lacks
 *
 *     You are AutoClaw. Answer the user directly and concisely.
 *
 * is refused with an empty-body 406, and so is one that carries a foreign
 * harness identity phrase (`you are claude code`, `you are codex`,
 * `claude agent sdk`, …) or a client-supplied `max_tokens`.
 *
 * 2.0.0 registers a real provider route (`atuoclaw`) and rewrites those three
 * things in a loopback shim, so any DSH session can select an AutoClaw model.
 *
 * ## Route table
 *
 * Host LLM route (loopback shim, random port + per-process secret):
 *
 * | | |
 * |---|---|
 * | provider id | `atuoclaw` |
 * | upstream | `https://autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions` |
 * | credential | the AutoClaw desktop app's own session, read via `safeStorage` |
 *
 * Browser routes (all `GET`, loopback-only, none of them writes upstream):
 *
 * | path | answers |
 * |---|---|
 * | `/plugins/dsh-connect-autoclaw/status` | balance, sub-wallets, expiry, account |
 * | `/plugins/dsh-connect-autoclaw/ledgers` | recent ledger entries |
 * | `/plugins/dsh-connect-autoclaw/catalog` | the model catalog; `?refresh=1` re-reads the gateway and re-announces the route (no restart) |
 *
 * The credential is **read, never written**: the app owns that file, and a
 * token refreshed here lives in this process only.
 *
 * @module dsh-connect-autoclaw
 */

import { hostIsLoopback, originIsLoopback } from './src/loopback.js'
import { readCredential, readProfile } from './src/credential.js'
import {
  appVersion,
  createUpstream,
  expiringOf,
  ledgersOf,
  readDeviceId,
  refreshAccessToken,
  walletsOf,
} from './src/upstream.js'
import { createShim, signedHeaders, classifyFailure, isFailoverable, REQUIRED_BANNER, translateRequest } from './src/shim.js'
import { createAccountLimiter, DEFAULT_MAX_CONCURRENT } from './src/ratelimit.js'
import { createTokenRefresher } from './src/refresh.js'
import { createAdapter } from './src/adapter.js'
import {
  importAccounts,
  listAccounts,
  loadState,
  pickAccount,
  readAppCredentials,
  readImportedCredential,
  saveState,
  vaultRoot,
} from './src/accounts.js'

export { decryptSafeStorage, readCredential } from './src/credential.js'
export { CLIENT, signedHeaders, walletsOf, expiringOf, ledgersOf } from './src/upstream.js'
export { createShim, translateRequest, neutralizeSystem, REQUIRED_BANNER } from './src/shim.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-connect-autoclaw'

const STATUS_PATH = '/plugins/dsh-connect-autoclaw/status'
const LEDGERS_PATH = '/plugins/dsh-connect-autoclaw/ledgers'
const MODELS_PATH = '/autoclaw-proxy/proxy/autoclaw-model-config'
const DIAG_PATH = '/plugins/dsh-connect-autoclaw/provider'
const CATALOG_PATH = '/plugins/dsh-connect-autoclaw/catalog'
const ACCOUNTS_PATH = '/plugins/dsh-connect-autoclaw/accounts'
const ACCOUNTS_SELECT_PATH = '/plugins/dsh-connect-autoclaw/accounts/select'
const ACCOUNTS_IMPORT_PATH = '/plugins/dsh-connect-autoclaw/accounts/import'
const POOL_PATH = '/plugins/dsh-connect-autoclaw/pool'
const REDEEM_PATH = '/plugins/dsh-connect-autoclaw/accounts/redeem'
const PROBE_PATH = '/plugins/dsh-connect-autoclaw/probe'

/** The provider route this plugin owns. */
export const PROVIDER_ID = 'atuoclaw'
export const PROVIDER_DISPLAY_NAME = 'atuoclaw'

/**
 * The model a spent allowance falls back to.
 *
 * `zai_auto` is the gateway's own router: it picks a working upstream model
 * per request, so it is the one entry least likely to be out of allowance
 * itself. Falling back to a specific model instead would just move the dead
 * end to a different id.
 */
export const FALLBACK_MODEL_ID = 'zai_auto'

/**
 * A SYNCHRONOUS catalog the model picker can read at registration time.
 *
 * `modelCatalog()` walks `listProviders()` → `listModels(provider)` the moment
 * `registerAdapter` publishes `llm/adapters-updated`. The real catalog only
 * arrives later (an async fetch to the gateway), so a provider whose catalog
 * starts empty is dropped from the picker by `groups.filter(models.length > 0)`
 * and never comes back. Both sibling connectors seed a fallback table for
 * exactly this reason; these are the five ids the live gateway advertises,
 * with the metadata it last published. `refreshCatalog()` replaces them.
 *
 * WINDOWS MATCH THE GATEWAY (v2.4.2). These are the real capacities AutoClaw
 * itself advertises in model_connections: 1,048,576 context for every model
 * except zai_glm-5.3-flashx-legal (307,200), with per-model maxTokens below.
 * An earlier build shrank them to 131,072 to force earlier compaction and save
 * points; that made the host treat every conversation as a 128K window and
 * compact at ~105K, which is the "context too small" symptom. The upstream
 * wire is unchanged — only the catalog-declared budgets the host uses for its
 * own pressure/compaction logic, so they must be the true numbers.
 */
const FALLBACK_MODELS = Object.freeze([
  { id: 'zai_auto', name: 'Auto', contextWindow: 1_048_576, maxTokens: 393_216, reasoningLevels: ['low', 'high', 'max'], multimodal: true, creditCostFactor: 0.4, credit: '低', tooltip: '根据任务自动选择合适模型' },
  { id: 'zai_auto-fast', name: 'Auto-Fast', contextWindow: 1_048_576, maxTokens: 131_072, reasoningLevels: ['low', 'high', 'max'], multimodal: true, creditCostFactor: 1, credit: '中', tooltip: '智能匹配可用模型，速度优先' },
  { id: 'zaicoding_glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxTokens: 307_200, reasoningLevels: ['low', 'high', 'max'], multimodal: false, creditCostFactor: 4.5, credit: '高', tooltip: '代码工程与复杂多步骤任务' },
  { id: 'zai_glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_048_576, maxTokens: 131_072, reasoningLevels: ['low', 'high', 'max'], multimodal: true, creditCostFactor: 0.5, credit: '低', tooltip: '截图理解、看图分析、视觉问答' },
  { id: 'zai_glm-5.3-flashx-legal', name: 'GLM-5.3-FlashX-Legal', contextWindow: 307_200, maxTokens: 131_072, reasoningLevels: ['low', 'high', 'max'], multimodal: true, creditCostFactor: 1.4, credit: '中', tooltip: '法律检索、合同审查' },
])

/** The namespace the Host really serves this plugin under. */
function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : 'dsh-connect-autoclaw'
}

// ---------------------------------------------------------------- probe
//
// The connectivity probe, sized after `dsh-connect-workbuddy`'s measured
// finding: a handful of tokens answers "usable" while every real request in a
// long conversation is refused, because upstream throttles on REQUEST SIZE.
// The filler is the sibling's own (English, measured ~4.5 chars/token), and
// the three tiers bracket it: 小 proves short-request liveness cheaply, 标准
// (~2.8 万 token ≈ 2.6 积分) covers the default conversation size, 大 (~5 万
// ≈ 4.6 积分) covers routinely-long sessions. AutoClaw's gateway refuses
// client `max_tokens` with a bare 406, so the output cap is a prompt
// constraint ("Reply with a single word."), not a field.
const POINTS_PER_TOTAL_TOKEN = 9.2e-5
const PROBE_TIMEOUT_MS = 90_000

import { resolveProbeTokens, probeMessages } from './src/probe.js'
import { createCatalogAnnouncer, catalogResponseBody } from './src/catalog.js'
import { annotateCatalog, fallbackChain, isQuotaExhausted, noteQuotaExhausted, pruneQuota } from './src/quota.js'
import { demotedModels, noteModelOutcome, pruneModelHealth } from './src/model-health.js'
export { resolveProbeTokens, probeMessages } from './src/probe.js'

/** Re-exported for the plugin's own consumers; the implementation lives in loopback.js. */
export { hostIsLoopback, originIsLoopback }

/** A tiny single-flight memo: the browser polls, AutoClaw's gateway should not see it. */
function createCache(seconds) {
  let at = 0
  let value
  let inflight
  const ttl = Math.max(1, seconds) * 1000
  return {
    get(load) {
      if (value !== undefined && Date.now() - at < ttl) return Promise.resolve(value)
      if (inflight !== undefined) return inflight
      inflight = load()
        .then((next) => {
          value = next
          at = Date.now()
          return next
        })
        .finally(() => {
          inflight = undefined
        })
      return inflight
    },
    clear() {
      value = undefined
      at = 0
    },
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Read one account's wallet document, refreshing the token in memory when it expired. */
async function readStatus(settings, cache) {
  return cache.get(async () => {
    const credential = await readCredential({ accountRoot: settings.accountRoot })
    const profile = await readProfile({ accountRoot: settings.accountRoot })
    const version = await appVersion({ appVersion: settings.appVersion })
    let token = credential.accessToken
    let refreshed = false
    const upstream = () =>
      createUpstream({
        baseURL: settings.baseURL,
        version,
        token,
        onUnauthorized: async () => {
          if (refreshed) return undefined
          refreshed = true
          const deviceId = await readDeviceId()
          const next = await refreshAccessToken({
            baseURL: settings.baseURL,
            refreshToken: credential.refreshToken,
            deviceId,
            version,
          })
          if (next !== undefined) token = next
          return next
        },
      })

    const wallets = await upstream().wallets()
    if (!wallets.ok) {
      return { ok: false, reason: wallets.code, message: wallets.message, fetchedAt: new Date().toISOString() }
    }
    const expiring = await upstream().expiring().catch(() => ({ ok: false }))
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      // The configured gateway, not a literal: the diagnostics tab must say what
      // this install actually talks to.
      baseURL: settings.baseURL,
      account: {
        id: credential.accountId,
        updatedAt: credential.updatedAt,
        refreshed,
        ...(profile === undefined ? {} : { profile }),
        maasExpiresAt: credential.maasExpiresAt,
      },
      total: typeof wallets.data?.total_balance === 'number' ? wallets.data.total_balance : 0,
      wallets: walletsOf(wallets.data),
      ...(expiring.ok ? { expiring: expiringOf(expiring.data) } : {}),
    }
  })
}

/**
 * Host half: two loopback routes, nothing else.
 *
 * No provider is registered and no model route is touched — AutoClaw has no
 * chat route inside the Harness, so a readout is the whole feature.
 */
/** The model catalog the gateway advertises, trimmed to what a picker needs. */
async function fetchCatalog(baseURL, accountRoot) {
  const credential = await readCredential({ accountRoot })
  const version = await appVersion({})
  const status = await fetch(`${baseURL}${MODELS_PATH}`, {
    headers: {
      ...signedHeaders(credential.accessToken, { version }),
      Accept: 'application/json',
    },
  }).catch(() => undefined)
  if (status === undefined || !status.ok) return []
  const parsed = await status.json().catch(() => undefined)
  const models = Array.isArray(parsed?.models) ? parsed.models : []
  return models
    .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string')
    .map((row) => {
      // Keep the gateway's advertised budgets intact. The host feeds these to
      // its own compaction logic; under-reporting them is what made every
      // conversation behave like a 128K window. See FALLBACK_MODELS above.
      const clampWindow = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback
      const clampTokens = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback
      return {
        id: row.id,
        name: typeof row.name === 'string' ? row.name : row.id,
        contextWindow: clampWindow(row.contextWindow, 1_048_576),
        maxTokens: clampTokens(row.maxTokens, 131_072),
        reasoningLevels: Array.isArray(row.reasoningLevel) ? row.reasoningLevel : undefined,
        multimodal: Array.isArray(row.input) && row.input.includes('image'),
        // Display-only fields the settings card's model section draws. Kept here
        // rather than re-derived in the browser: the gateway is the only source.
        credit: typeof row.creditConsumptionLevel === 'string' ? row.creditConsumptionLevel : '',
        creditCostFactor: Number.isFinite(row.creditCostFactor) ? row.creditCostFactor : undefined,
        tooltip: typeof row.tooltip === 'string' ? row.tooltip : '',
      }
    })
}

export function apply(ctx, config = {}) {
  const settings = {
    baseURL: (config.baseURL ?? 'https://autoglm-api.zhipuai.cn').replace(/\/+$/, ''),
    cacheSeconds: Number(config.cacheSeconds ?? 60),
    accountRoot: config.accountRoot ?? '',
    appVersion: config.appVersion ?? '',
    rateLimitIntervalMs: config.rateLimitIntervalMs ?? 400,
    rateLimitEnabled: config.rateLimitEnabled !== false,
    // In-flight requests allowed per account. 1 restores the old serial gate;
    // 4 is the measured sweet spot (see src/ratelimit.js for the numbers).
    maxConcurrentPerAccount: config.maxConcurrentPerAccount ?? DEFAULT_MAX_CONCURRENT,
    // 429/5xx demotion: consecutive failures that trip it, and the first cooldown.
    modelHealthOptions: {
      threshold: config.modelFailureThreshold,
      cooldownMs: config.modelCooldownMs,
      maxCooldownMs: config.modelMaxCooldownMs,
    },
    refreshLeadMs: config.refreshLeadMs ?? 60_000,
  }
  const cache = createCache(Number.isFinite(settings.cacheSeconds) ? settings.cacheSeconds : 60)

  // ---------------------------------------------------------------- provider
  //
  // Everything below is optional: a profile without `llm` (or without the
  // pi-ai stack) still gets the points readout, instead of failing to load.
  const providerState = {
    registered: false, error: '', shimUrl: '', catalogSize: 0, catalogError: '',
    catalogLive: false, listModelsCount: 0, listModelsIds: [], listModelsError: '',
    catalogUpdatedAt: '',
    // Which build the host actually loaded. Bumped whenever the host half
    // changes, so a running process can be identified without guesswork.
    build: '2026-11-24-overload-and-pool',
  }
  // Seeded synchronously: the GUI reads the catalog as soon as the adapter is
  // registered, long before the gateway request below resolves.
  let catalogCache = [...FALLBACK_MODELS]
  let catalogLive = false
  const catalog = () => catalogCache
  const refreshCatalog = async () => {
    try {
      const next = await fetchCatalog(settings.baseURL, settings.accountRoot)
      if (next.length > 0) {
        catalogCache = next
        catalogLive = true
      }
    } catch (error) {
      providerState.catalogError = String(error?.message ?? error)
      ctx.logger?.warn?.(`dsh-connect-autoclaw: model catalog unavailable: ${providerState.catalogError}`)
    }
    return catalogCache
  }

  // Set once the llm stack is active (below); the catalog route uses it to
  // re-read the gateway and re-announce the route without a process restart.
  let announceFresh = undefined

  // ---------------------------------------------------------------- accounts
  //
  // The pool: every app account plus every imported one, one selection, and
  // probe records that bench a credential after a failoverable failure.
  // State lives in the plugin's own vault; the app's files stay read-only.
  // State loads asynchronously (apply() is sync by contract): handlers await
  // `stateReady`, so no request races the read. Defaults apply until then.
  const state = { selectedAccountId: '', poolEnabled: false, probes: {}, probeTier: undefined, quota: {}, modelHealth: {} }
  // WHAT THE PICKER SEES. `modelCatalog()` reads `group.models[].name` for its
  // labels, so an exhausted model is decorated there — the one field that
  // reaches the model selector. `quotaExhausted` rides along as structured data
  // for this plugin's own card.
  //
  // Declared at `apply` scope, NOT inside the `llm` injection: the catalog route
  // lives in the `webServer` injection, which is a sibling, and a definition
  // nested in one is `undefined` in the other (that threw, and the route
  // answered 400).
  const annotated = () => annotateCatalog(catalog(), {
    quota: state.quota,
    demoted: demotedModels(state.modelHealth),
    suffix: (name) => `${name} · 额度已用完`,
    demotedSuffix: (name) => `${name} · 暂时不可用`,
  })

  const stateReady = loadState().then((loaded) => {
    Object.assign(state, loaded)
  }).catch((error) => {
    ctx.logger?.warn?.(`dsh-connect-autoclaw: state load failed: ${String(error)}`)
  })
  const persistState = () => saveState(state).catch((error) => {
    ctx.logger?.warn?.(`dsh-connect-autoclaw: state save failed: ${String(error)}`)
  })

  // Proactive refresh: refresh shortly before expiry so a request never has to
  // ride the reactive 410000 path. Memory-only — the app owns the credential file.
  const refresher = createTokenRefresher({
    leadMs: Number.isFinite(settings.refreshLeadMs) ? settings.refreshLeadMs : 60_000,
    refresh: async ({ credential }) => {
      try {
        const deviceId = await readDeviceId()
        return await refreshAccessToken({
          baseURL: settings.baseURL,
          refreshToken: credential.refreshToken,
          deviceId,
          version: await appVersion({ appVersion: settings.appVersion }),
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-connect-autoclaw: proactive refresh failed: ${String(error?.message ?? error)}`)
        return undefined
      }
    },
  })

  // Per-account request gate: a bounded concurrency window plus a minimum gap
  // between dispatches. Serialising on one slot made concurrency worse than
  // useless — TTFB p50 went 623 ms → 4331 ms at 4 concurrent callers — because
  // every request waited for the previous one's whole response. The window lets
  // independent requests overlap; `rateLimitIntervalMs` still paces dispatch.
  const limiter = createAccountLimiter({
    maxConcurrentPerAccount: settings.maxConcurrentPerAccount,
    minIntervalMs: Number.isFinite(settings.rateLimitIntervalMs) ? settings.rateLimitIntervalMs : 400,
    enabled: settings.rateLimitEnabled,
  })

  const balances = new Map() // accountId -> { total, expiringPoints }
  const balancesAt = new Map() // accountId -> read time
  const BALANCE_TTL_MS = 5 * 60 * 1000
  const accountsCache = { at: 0, rows: [] }
  const ACCOUNTS_TTL_MS = 30 * 1000

  const listAccountsCached = async (fresh = false) => {
    if (!fresh && accountsCache.rows.length > 0 && Date.now() - accountsCache.at < ACCOUNTS_TTL_MS) {
      return accountsCache.rows
    }
    const rows = await listAccounts({ accountRoot: settings.accountRoot || undefined })
    accountsCache.rows = rows
    accountsCache.at = Date.now()
    return rows
  }

  /** Read one account's wallet; caches per account for 5 minutes. */
  const readBalance = async (credential, fresh = false) => {
    const id = credential.accountId
    if (!fresh && balancesAt.has(id) && Date.now() - balancesAt.get(id) < BALANCE_TTL_MS) {
      return balances.get(id)
    }
    try {
      const version = await appVersion({})
      const upstream = createUpstream({ baseURL: settings.baseURL, version, token: credential.accessToken })
      const wallets = await upstream.wallets()
      if (!wallets.ok) throw new Error(wallets.message ?? String(wallets.code))
      const expiring = await upstream.expiring().catch(() => ({ ok: false }))
      const value = {
        total: typeof wallets.data?.total_balance === 'number' ? wallets.data.total_balance : 0,
        expiringPoints: expiring.ok ? (expiring.data?.expiring_points ?? 0) : 0,
      }
      balances.set(id, value)
      balancesAt.set(id, Date.now())
      return value
    } catch (error) {
      ctx.logger?.warn?.(`dsh-connect-autoclaw: balance read for ${id.slice(0, 8)}… failed: ${String(error?.message ?? error)}`)
      return undefined
    }
  }

  /** All credentials we can serve right now: app dirs + vault imports. */
  const readAllCredentials = async (fresh = false) => {
    const accounts = await listAccountsCached(fresh)
    const map = await readAppCredentials(accounts, { accountRoot: settings.accountRoot || undefined })
    for (const account of accounts) {
      if (account.source !== 'vault' || map.has(account.accountId)) continue
      const imported = await readImportedCredential(account.accountId)
      if (imported !== undefined) map.set(account.accountId, imported)
    }
    return { accounts, credentials: map }
  }

  // The shim's account resolver. Pool ON excludes probed-out accounts and
  // everything the current request already tried; pool OFF serves the
  // selected (or newest) account only.
  const getAccount = async ({ exclude = [] } = {}) => {
    await stateReady
    const { accounts, credentials } = await readAllCredentials()
    const picked = pickAccount({ accounts, credentials, state, balances, exclude })
    if (picked === undefined) return undefined
    const credential = credentials.get(picked.accountId)
    return credential === undefined ? undefined : refresher.ensureFresh(credential)
  }

  // Probe records: only a FAILOVERABLE failure benches the account for the
  // pool's cooldown; a request-class failure (400/406/413) must NOT — with one
  // account that would take the whole provider out of service. A success
  // clears any stale bench.
  const onAccountOutcome = (accountId, outcome) => {
    if (outcome?.kind === 'ok') {
      if (state.probes[accountId]?.ok === false) {
        delete state.probes[accountId]
        void persistState()
      }
      return
    }
    if (!isFailoverable(outcome?.kind ?? 'network')) return
    state.probes[accountId] = {
      ok: false,
      kind: outcome?.kind ?? 'unknown',
      status: outcome?.status,
      at: Date.now(),
    }
    void persistState()
  }

  ctx.inject(['llm'], (llmCtx) => {
    // One builder for every model choice this plugin makes: the first attempt,
    // each fallback hop, and the diagnostics view all agree on which models are
    // currently unusable (allowance gone OR cooling down).
    const chainFor = (requested) => fallbackChain({
      model: requested,
      catalog: catalog().map((row) => row.id),
      preferred: FALLBACK_MODEL_ID,
      quota: state.quota,
      demoted: demotedModels(state.modelHealth),
    })

    const shim = createShim({
      baseURL: settings.baseURL,
      accountRoot: settings.accountRoot,
      logger: ctx.logger,
      listModels: () => annotated().map((info) => ({ id: info.id, object: 'model', owned_by: PROVIDER_ID })),
      getAccount,
      onAccountOutcome,
      // Credential-class retry: a token the gateway revoked still carries a
      // future `exp`, so the proactive path above skips it. This is the only
      // hook that can refresh it before the request is given up on.
      forceRefresh: (credential) => refresher.forceRefresh(credential),
      // A model that just answered 810000 is out of its own allowance; the
      // shim asks which model to call instead of retrying the same one.
      onQuotaExhausted: (model, detail) => {
        noteQuotaExhausted(state.quota, model, detail)
        pruneQuota(state.quota)
        void persistState()
        // The picker must relabel without waiting for the next catalog poll.
        try { registration?.replace?.([PROVIDER_ID]) } catch { /* not yet held */ }
      },
      // Per-model health: a 429/5xx counts against the MODEL. Past the
      // threshold it cools down for a doubling window, and the shim advances
      // the chain at once instead of spending the rest of its budget on it.
      onModelOutcome: (model, outcome) => {
        const verdict = noteModelOutcome(state.modelHealth, model, outcome, settings.modelHealthOptions)
        pruneModelHealth(state.modelHealth)
        if (verdict.demoted === true) void persistState()
        return verdict
      },
      // Before the first attempt: replace the requested model ONLY if the
      // health record already knows it cannot serve.
      //
      // Returning `chainFor(requested)[0]` was a bug: `fallbackChain` always
      // puts the preferred model (Auto) first, so every explicit choice —
      // GLM-5.4, GLM-5.3, anything — was silently rewritten to Auto and the
      // user's selection never reached upstream. Observed as three GLM-5.4
      // requests answering "by zai_auto" with zero upstream hits on GLM-5.4.
      initialModel: (requested) => {
        if (typeof requested !== 'string' || requested === '') return requested
        const unavailable = isQuotaExhausted(state.quota, requested)
          || demotedModels(state.modelHealth).includes(requested)
        if (!unavailable) return requested
        // It cannot serve: hand back the chain's first entry that can.
        return chainFor(requested)[0]
      },
      nextFallback: (attemptModel) => {
        // The shim already failed on the first entry; hand it the next one.
        return chainFor(attemptModel).find((id) => id !== attemptModel)
      },
      limiter,
    })
    const built = createAdapter({
      provider: PROVIDER_ID,
      displayName: PROVIDER_DISPLAY_NAME,
      shim,
      catalog,
      getAttachments: () => ctx.get('attachments'),
      getFs: () => ctx.get('fs'),
    })

    let registration
    let directory
    let discovery
    try {
      registration = llmCtx.llm.registerAdapter([PROVIDER_ID], built.adapter)
      // The Model picker's `modelCatalog()` joins `listProviders()` with
      // `listConfigurableProviders()`; a route with no directory entry is
      // still listed, but the Models settings page cannot address it. Both
      // sibling connectors register all three, so this one does too.
      directory = llmCtx.llm.registerConfigurableProviders([{
        provider: PROVIDER_ID,
        displayName: PROVIDER_DISPLAY_NAME,
        settingsNs: settingsNamespaceOf(ctx),
        settingsPath: [],
        declared: false,
      }])
      discovery = llmCtx.llm.registerModelDiscovery(settingsNamespaceOf(ctx), async () =>
        annotated().map((info) => ({
          id: info.id,
          name: info.name ?? info.id,
          ...(Number.isFinite(info.contextWindow) ? { contextWindow: info.contextWindow } : {}),
          ...(Number.isFinite(info.maxTokens) ? { maxTokens: info.maxTokens } : {}),
          inputModalities: info.multimodal === true ? ['text', 'image'] : ['text'],
        })))
      providerState.registered = true
      // `listen(0)` settles asynchronously; reading baseUrl() now would report port 0.
      void shim.ready.then(() => { providerState.shimUrl = shim.baseUrl() })
    } catch (error) {
      providerState.error = String(error?.message ?? error)
      ctx.logger?.error?.(`dsh-connect-autoclaw: provider registration failed: ${providerState.error}`)
      try { registration?.() } catch { /* not yet held */ }
      try { directory?.() } catch { /* not yet held */ }
      try { discovery?.() } catch { /* not yet held */ }
      shim.close().catch(() => {})
      return
    }

    llmCtx.effect(() => () => {
      try { registration() } catch { /* already disposed by the fiber */ }
      try { directory() } catch { /* already disposed by the fiber */ }
      try { discovery() } catch { /* already disposed by the fiber */ }
      shim.close().catch(() => {})
    })

    // One announcer for every catalog change: re-read, report, invalidate,
    // re-announce so `llm/adapters-updated` fires and the model picker
    // re-reads. The first read is deferred (activation must not block on the
    // network) but uses the very same sequence the hot-refresh route runs.
    const announce = createCatalogAnnouncer({
      refresh: async () => { await refreshCatalog(); return catalogCache },
      report: (size, live) => {
        providerState.catalogSize = size
        providerState.catalogLive = live
        providerState.catalogUpdatedAt = new Date().toISOString()
      },
      invalidate: () => built.invalidate(),
      replace: () => registration.replace([PROVIDER_ID]),
      logger: ctx.logger,
    })
    announceFresh = announce
    void announce().then(async () => {
      // Real evidence for the picker: ask the very service `modelCatalog()`
      // walks. `listModels` on our own adapter must answer the seeded rows.
      try {
        const listed = await llmCtx.llm.listModels(PROVIDER_ID)
        providerState.listModelsCount = listed.length
        providerState.listModelsIds = listed.map((model) => model.id)
      } catch (error) {
        providerState.listModelsError = String(error?.message ?? error)
      }
    })
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const guard = (req, res, { methods = ['GET'] } = {}) => {
        if (!methods.includes(req.method)) {
          sendJson(res, 405, { error: 'method not allowed' })
          return false
        }
        if (!hostIsLoopback(req.headers.host)) {
          sendJson(res, 403, { error: 'host not allowed' })
          return false
        }
        if (!originIsLoopback(req.headers.origin)) {
          sendJson(res, 403, { error: 'origin not allowed' })
          return false
        }
        return true
      }

      /** Read a JSON POST body with the same size cap the shim enforces. */
      const readPostBody = async (req) => {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 1024 * 1024) throw new Error('request body too large')
          chunks.push(chunk)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      }

      /** The probe view a roster row shows: only a live failure is news. */
      const probeExcludesView = (probe) => {
        if (probe === null || typeof probe !== 'object' || probe.ok !== false) return null
        if (typeof probe.at !== 'number' || Date.now() - probe.at >= 30 * 60 * 1000) return null
        return { kind: probe.kind, status: probe.status, at: probe.at }
      }

      const disposeStatus = webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          const url = new URL(req.url ?? '', 'http://localhost')
          if (url.searchParams.get('fresh') === '1') cache.clear()
          try {
            sendJson(res, 200, await readStatus(settings, cache))
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              reason: 'CREDENTIAL',
              message: String(error?.message ?? error),
              fetchedAt: new Date().toISOString(),
            })
          }
        },
      })

      const disposeLedgers = webCtx.webServer.register({
        kind: 'exact',
        path: LEDGERS_PATH,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          try {
            const credential = await readCredential({ accountRoot: settings.accountRoot })
            const version = await appVersion({ appVersion: settings.appVersion })
            const upstream = createUpstream({
              baseURL: settings.baseURL,
              version,
              token: credential.accessToken,
              onUnauthorized: async () => {
                const deviceId = await readDeviceId()
                return refreshAccessToken({
                  baseURL: settings.baseURL,
                  refreshToken: credential.refreshToken,
                  deviceId,
                  version,
                })
              },
            })
            const ledgers = await upstream.ledgers()
            sendJson(
              res,
              200,
              ledgers.ok
                ? { ok: true, entries: ledgersOf(ledgers.data), fetchedAt: new Date().toISOString() }
                : { ok: false, reason: ledgers.code, message: ledgers.message },
            )
          } catch (error) {
            sendJson(res, 200, { ok: false, reason: 'CREDENTIAL', message: String(error?.message ?? error) })
          }
        },
      })

      const disposeDiag = webCtx.webServer.register({
        kind: 'exact',
        path: DIAG_PATH,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          sendJson(res, 200, {
            provider: PROVIDER_ID,
            ...providerState,
            models: catalogCache.map((info) => info.id),
            // Full catalog for the settings card's model section. Every field
            // here came from the gateway; the browser does not re-derive it.
            catalog: catalogCache,
            catalogLive,
            // THE GATE, as the running process sees it: per-account window,
            // what is in flight, and what is queued behind a full window.
            // `snapshot('*')` would look up a literal account named "*", so the
            // all-lanes view is its own call.
            limiter: limiter.snapshotAll(),
            // Models currently cooling down from rate/server failures.
            modelHealth: { demoted: demotedModels(state.modelHealth), records: state.modelHealth },
          })
        },
      })

      // CATALOG — the model catalog, hot-refreshable. A plain GET answers the
      // cached rows; `?refresh=1` re-reads the gateway and re-announces the
      // route, so gateway-side model changes reach the picker without a
      // restart. Code-level changes are different: reload the bundle via
      // plugin_manager (set_bundle disable→enable) or restart.
      const disposeCatalog = webCtx.webServer.register({
        kind: 'exact',
        path: CATALOG_PATH,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          const url = new URL(req.url ?? '', 'http://localhost')
          const wantsRefresh = url.searchParams.get('refresh') === '1'
          if (wantsRefresh) {
            if (announceFresh === undefined) {
              sendJson(res, 200, { ok: false, reason: 'provider-not-loaded', message: 'the llm stack is not active in this profile; nothing to refresh' })
              return
            }
            await announceFresh()
          }
          sendJson(res, 200, catalogResponseBody({
            provider: PROVIDER_ID, cache: annotated(), state: providerState,
            refreshed: wantsRefresh && announceFresh !== undefined,
          }))
        },
      })

      // THE ACCOUNT ROSTER: every app account + every imported one, with
      // profile, balance, selection and pool state. Balances cost one
      // upstream read per account, so they are cached for 5 minutes and only
      // re-read on `?fresh=1` (the card's refresh button) — a roster render
      // must never multiply upstream reads.
      const disposeAccounts = webCtx.webServer.register({
        kind: 'exact',
        path: ACCOUNTS_PATH,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          const url = new URL(req.url ?? '', 'http://localhost')
          const fresh = url.searchParams.get('fresh') === '1'
          try {
            const accounts = await listAccountsCached(fresh)
            const { credentials } = await readAllCredentials(fresh)
            const rows = []
            for (const account of accounts) {
              const credential = credentials.get(account.accountId)
              const balance = credential === undefined ? undefined : await readBalance(credential, fresh)
              const probe = state.probes[account.accountId]
              rows.push({
                accountId: account.accountId,
                source: account.source,
                name: account.profile?.displayName ?? account.profile?.phone ?? undefined,
                phone: account.profile?.phone ?? undefined,
                available: credential !== undefined,
                selected: state.selectedAccountId === account.accountId,
                balance: balance?.total,
                expiringPoints: balance?.expiringPoints,
                probe: probeExcludesView(probe),
              })
            }
            sendJson(res, 200, {
              ok: true,
              poolEnabled: state.poolEnabled === true,
              hasCheckin: false,
              probeTier: state.probeTier ?? 'standard',
              rows,
              fetchedAt: new Date().toISOString(),
            })
          } catch (error) {
            sendJson(res, 200, { ok: false, message: String(error?.message ?? error) })
          }
        },
      })

      // Selection: strictly bound, never silently switched by the pool.
      const disposeSelect = webCtx.webServer.register({
        kind: 'exact',
        path: ACCOUNTS_SELECT_PATH,
        handler: async (req, res) => {
          if (!guard(req, res, { methods: ['POST'] })) return
          await stateReady
            try {
            const body = await readPostBody(req)
            const accountId = typeof body.accountId === 'string' ? body.accountId : ''
            const accounts = await listAccountsCached(true)
            if (accountId === '' || !accounts.some((account) => account.accountId === accountId)) {
              sendJson(res, 200, { ok: false, message: 'unknown accountId' })
              return
            }
            state.selectedAccountId = accountId
            await persistState()
            sendJson(res, 200, { ok: true, selectedAccountId: accountId })
          } catch (error) {
            sendJson(res, 200, { ok: false, message: String(error?.message ?? error) })
          }
        },
      })

      // The pool switch. Explicit user choice, default OFF — switching
      // accounts means switching who pays.
      const disposePool = webCtx.webServer.register({
        kind: 'exact',
        path: POOL_PATH,
        handler: async (req, res) => {
          if (!guard(req, res, { methods: ['POST'] })) return
          await stateReady
            try {
            const body = await readPostBody(req)
            state.poolEnabled = body.enabled === true
            await persistState()
            sendJson(res, 200, { ok: true, poolEnabled: state.poolEnabled })
          } catch (error) {
            sendJson(res, 200, { ok: false, message: String(error?.message ?? error) })
          }
        },
      })

      // Export: the vault + app roster as one JSON download. Tokens are
      // credentials; the card treats the file like a password.
      const disposeExport = webCtx.webServer.register({
        kind: 'exact',
        path: ACCOUNTS_IMPORT_PATH.replace(/import$/, 'export'),
        handler: async (req, res) => {
          if (!guard(req, res)) return
          try {
            const accounts = await listAccountsCached(true)
            const { credentials } = await readAllCredentials(true)
            const rows = []
            for (const account of accounts) {
              const credential = credentials.get(account.accountId)
              if (credential === undefined) continue
              rows.push({
                accountId: account.accountId,
                accessToken: credential.accessToken,
                refreshToken: credential.refreshToken ?? '',
                profile: account.profile ?? {},
                source: account.source,
              })
            }
            const body = JSON.stringify({
              schemaVersion: 1,
              kind: 'atuoclaw-accounts',
              exportedAt: new Date().toISOString(),
              accounts: rows,
            })
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': `attachment; filename="atuoclaw-accounts-${new Date().toISOString().slice(0, 10)}.json"`,
              'cache-control': 'no-store',
            })
            res.end(body)
          } catch (error) {
            sendJson(res, 200, { ok: false, message: String(error?.message ?? error) })
          }
        },
      })

      // Import: merge into the plugin's own vault. The app's account
      // directories are never written; a record whose id collides with an app
      // account updates the vault copy but the app's own credential still
      // wins at read time.
      const disposeImport = webCtx.webServer.register({
        kind: 'exact',
        path: ACCOUNTS_IMPORT_PATH,
        handler: async (req, res) => {
          if (!guard(req, res, { methods: ['POST'] })) return
          try {
            const body = await readPostBody(req)
            const result = await importAccounts(body.accounts, {})
            accountsCache.at = 0 // force a roster re-read
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(res, 200, { ok: false, message: String(error?.message ?? error) })
          }
        },
      })

      // Redeem: the ONLY credit-granting write the upstream publishes
      // (`/agent-assetmgr/api/v1/autoglm-codes/redeem`). There is NO check-in
      // endpoint in AutoClaw — the daily grants in the ledger are automatic —
      // so the card renders this instead of inventing one.
      const disposeRedeem = webCtx.webServer.register({
        kind: 'exact',
        path: REDEEM_PATH,
        handler: async (req, res) => {
          if (!guard(req, res, { methods: ['POST'] })) return
          try {
            const body = await readPostBody(req)
            const code = typeof body.code === 'string' ? body.code.trim() : ''
            const accountId = typeof body.accountId === 'string' ? body.accountId : ''
            if (code === '') {
              sendJson(res, 200, { ok: false, message: 'code is empty' })
              return
            }
            const { credentials } = await readAllCredentials()
            let credential = accountId !== '' ? credentials.get(accountId) : undefined
            if (credential === undefined) credential = await getAccount({ exclude: [] })
            if (credential === undefined) {
              sendJson(res, 200, { ok: false, message: 'no available account credential' })
              return
            }
            const version = await appVersion({})
            const response = await fetch(`${settings.baseURL}/agent-assetmgr/api/v1/autoglm-codes/redeem`, {
              method: 'POST',
              headers: {
                ...signedHeaders(credential.accessToken, { version }),
                'content-type': 'application/json',
              },
              body: JSON.stringify({ biz_app_id: 'autoclaw', code }),
            })
            const parsed = await response.json().catch(() => undefined)
            sendJson(res, 200, {
              ok: response.status === 200 && parsed?.code === 0,
              status: response.status,
              code: parsed?.code,
              message: typeof parsed?.message === 'string' ? parsed.message : undefined,
            })
          } catch (error) {
            sendJson(res, 200, { ok: false, message: String(error?.message ?? error) })
          }
        },
      })

      // THE PROBE: one real-volume request per model, so "测出可用" means the
      // account can serve a conversation-sized body, not just a ping. Never
      // throws; classifies failures the same way the shim does, and feeds the
      // pool's probe records (a successful probe un-benches the account).
      const disposeProbe = webCtx.webServer.register({
        kind: 'exact',
        path: PROBE_PATH,
        handler: async (req, res) => {
          if (!guard(req, res, { methods: ['POST'] })) return
          try {
            const body = await readPostBody(req)
            const model = typeof body.model === 'string' && body.model !== '' ? body.model : 'zai_glm-5.3-flash'
            const tier = typeof body.tier === 'string' ? body.tier : undefined
            const tokens = resolveProbeTokens(tier)
            const accountId = typeof body.accountId === 'string' ? body.accountId : ''
            await stateReady
            const { credentials } = await readAllCredentials()
            let credential = accountId !== '' ? credentials.get(accountId) : undefined
            if (credential === undefined) credential = await getAccount({ exclude: [] })
            if (credential === undefined) {
              sendJson(res, 200, { ok: false, outcome: 'no-account', message: 'no available account credential' })
              return
            }
            // Remember the tier for the card's next render.
            if (state.probeTier !== tier) {
              state.probeTier = tier
              void persistState()
            }
            const version = await appVersion({})
            const payload = translateRequest({
              model, stream: false, messages: probeMessages(model, tokens),
            })
            const startedAt = Date.now()
            const response = await fetch(`${settings.baseURL}/autoclaw-proxy/proxy/autoclaw/chat/completions`, {
              method: 'POST',
              headers: {
                ...signedHeaders(credential.accessToken, { version }),
                'content-type': 'application/json',
                'X-Authorization': /^Bearer\s+/i.test(credential.accessToken)
                  ? credential.accessToken
                  : `Bearer ${credential.accessToken}`,
                'X-Request-Model': model,
                'X-Client-Type': 'pc',
                'X-Agent-Id': 'main',
                'X-Trace-Id': crypto.randomUUID(),
                'x_trace_id': 'autoclaw-desktop',
                Accept: 'application/json',
              },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            })
            const latencyMs = Date.now() - startedAt
            const text = await response.text().catch(() => '')
            const parsed = JSON.parse(text.length > 0 ? text : '{}')
            if (response.ok && parsed?.usage) {
              onAccountOutcome(credential.accountId, { kind: 'ok', status: 200 })
              const promptTokens = parsed.usage.prompt_tokens ?? 0
              const totalTokens = parsed.usage.total_tokens ?? promptTokens
              sendJson(res, 200, {
                ok: true,
                outcome: 'ok',
                model,
                tier,
                accountId: credential.accountId,
                latencyMs,
                promptTokens,
                totalTokens,
                pointsEstimate: Math.round(totalTokens * POINTS_PER_TOTAL_TOKEN * 10) / 10,
                message: typeof parsed.choices?.[0]?.message?.content === 'string'
                  ? parsed.choices[0].message.content.slice(0, 40)
                  : undefined,
              })
              return
            }
            const kind = classifyFailure(response.status, text)
            // A probe exercises the SAME account+model path a real request
            // takes, so its failure feeds the pool's bench exactly like a real
            // one — except request-class failures (400 非法模型, 406 gate),
            // which say nothing about the credential.
            if (isFailoverable(kind)) {
              onAccountOutcome(credential.accountId, { kind, status: response.status, message: text.slice(0, 200) })
            }
            sendJson(res, 200, {
              ok: false,
              outcome: kind,
              status: response.status,
              model,
              tier,
              accountId: credential.accountId,
              latencyMs,
              message: text.slice(0, 240) || `HTTP ${response.status}`,
            })
          } catch (error) {
            sendJson(res, 200, { ok: false, outcome: 'network', message: String(error?.message ?? error) })
          }
        },
      })

      return () => {
        disposeStatus()
        disposeLedgers()
        disposeDiag()
        disposeCatalog()
        disposeAccounts()
        disposeSelect()
        disposePool()
        disposeExport()
        disposeImport()
        disposeRedeem()
        disposeProbe()
      }
    })
  })
}
