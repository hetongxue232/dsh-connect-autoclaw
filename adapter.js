/**
 * The pi-ai bridge: one provider object, mounted as a DSH `PiAiAdapter`.
 *
 * Assembly follows `dsh-connect-zhipu`'s verified shape:
 *
 * - models are built from the LIVE catalog on every read (`getModels`
 *   delegation), so a refresh reaches the next request without rebuilding;
 * - every model's `baseUrl` points at the loopback shim, so the account token
 *   stays inside the host process;
 * - the pi-ai transcript is FOLDED for the 1.x seam: `dsh-llm-pi-ai` under
 *   pi-ai 1.x hands the api a RAW envelope whose prompt and tools live at the
 *   top, and pi-ai 1.x reads them from a leading `system` message instead. An
 *   unfolded envelope reaches the shim with no system prompt at all — which is
 *   exactly the bare-406 shape this whole plugin exists to avoid.
 *
 * @module dsh-connect-autoclaw/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

/**
 * These four imports are STATIC on purpose, exactly like `dsh-connect-zhipu`.
 *
 * Neither package is installed beside a profile bundle: they live in the dsh
 * installation, and the Loader reaches them through Node's internal cascaded
 * loader, which resolves against the application's own module graph rather
 * than this file's directory. A `createRequire(import.meta.url)` here would
 * therefore look in the wrong place and fail; a static import is what the
 * loader can rewrite.
 */

/** No per-token pricing is knowable through a plan quota. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Idle bound for one stream read; thinking streams can pause for a while. */
const STREAM_IDLE_TIMEOUT_MS = 600_000

/**
 * Request-image budgets pinned far above any real request: the gateway caps on
 * its own, and a silent narrowing from a dependency bump is worse than none.
 * `imageOffloadCountQuantum` must not exceed `maxRequestImages`.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImages: 1e6,
  imageOffloadCountQuantum: 1e6,
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/** Inert pi-ai auth plane: this route authenticates only through the shim secret. */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return [] },
  },
}

/**
 * Move `systemPrompt` and `tools` into a leading `system` message, which is
 * where pi-ai 1.x's transcript protocol reads them from. Idempotent: a context
 * that already carries no top-level prompt or tools passes through untouched.
 */
export function foldModernContext(context) {
  if (context === null || typeof context !== 'object') return context
  const prompt = context.systemPrompt
  const tools = context.tools
  const hasPrompt = typeof prompt === 'string' && prompt !== ''
  const hasTools = Array.isArray(tools) && tools.length > 0
  if (!hasPrompt && !hasTools) return context
  const system = {
    role: 'system',
    content: hasPrompt ? prompt : '',
    ...(hasTools ? { toolsAdded: tools } : {}),
    timestamp: 0,
  }
  const { systemPrompt: _prompt, tools: _tools, ...rest } = context
  return { ...rest, messages: [system, ...context.messages] }
}

/** Wrap one pi-ai API module so both stream entry points receive a folded transcript. */
function withModernContext(api) {
  const prepare = (context) => foldModernContext(context)
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, prepare(context), options),
    streamSimple: (model, context, options) => api.streamSimple(model, prepare(context), options),
  }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
/** Every tier pi-ai knows about, in its own escalation order. */
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Map pi-ai's tiers onto the ones this model advertises.
 *
 * pi-ai's rule (`getSupportedThinkingLevels`) is a DENYLIST: a tier is offered
 * unless its map entry is `null`, and `xhigh` / `max` additionally require a
 * non-undefined entry. So the map has to name every unsupported tier explicitly
 * — an absent key would silently offer a tier the gateway rejects.
 */
export function thinkingLevelMapOf(reasoningLevels) {
  if (!Array.isArray(reasoningLevels) || reasoningLevels.length === 0) return undefined
  const offered = new Set(reasoningLevels)
  return Object.fromEntries(
    ALL_THINKING_LEVELS.map((level) => [level, offered.has(level) ? level : null]),
  )
}

export function toPiModel(info, baseUrl, identity) {
  const thinkingLevelMap = thinkingLevelMapOf(info.reasoningLevels)
  return {
    id: info.id,
    name: info.name ?? info.id,
    api: 'openai-completions',
    provider: identity,
    baseUrl: `${baseUrl}/v1`,
    input: info.multimodal === true ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow ?? 131_072,
    maxTokens: info.maxTokens ?? 8_192,
    reasoning: thinkingLevelMap !== undefined,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    compat: { supportsReasoningEffort: thinkingLevelMap !== undefined },
  }
}

/** Assemble the adapter for one catalog. */
export function createAdapter(options) {
  // ponytail: attachments 由 index.js 从 ctx 取来传入（可选）。不传时图片请求会被
  // PiAiAdapter 以 UNSUPPORTED_CONTENT 拒绝；传了就能读 durable attachment store。
  const { provider, displayName, shim, catalog, getAttachments, getFs } = options
  const buildModels = () => catalog().map((info) => toPiModel(info, shim.baseUrl(), provider))

  const providerObject = {
    ...createProvider({
      id: provider,
      name: displayName,
      auth: {
        apiKey: {
          name: 'AutoClaw shim secret',
          async resolve() {
            return { auth: { apiKey: shim.token() }, source: 'dsh-connect-autoclaw shim' }
          },
        },
      },
      models: buildModels(),
      api: withModernContext(openAICompletionsApi()),
    }),
    getModels: () => buildModels(),
  }

  const profileFor = (key) => ({
    provider: key,
    displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-autoclaw retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: providerObject,
  })

  let profiles = new Map([[provider, profileFor(provider)]])

  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      // 图片：durable attachment store，按请求实时解析（服务可能晚于本适配器挂载）。
      resolveAttachments: () => getAttachments?.() ?? undefined,
      resolveImageAccess: (store, ref) => {
        const fsService = getFs?.()
        return resolveImageAttachmentAccess(store, (hostPath) => fsService?.processPathFromHostPath?.(hostPath), ref)
      },
    }),
    invalidate: () => {
      profiles = new Map([[provider, profileFor(provider)]])
    },
  }
}
