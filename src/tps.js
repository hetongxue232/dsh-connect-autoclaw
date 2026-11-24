/**
 * Output-speed measurement: how fast does each AutoClaw model actually write?
 *
 * ## Why this exists
 *
 * "The tokens are too slow" is unanswerable without a number. Latency and
 * throughput are different quantities — a model can answer fast and then crawl,
 * or think for seconds and then pour out tokens — and AutoClaw's own gateway
 * adds an auto-router on top, so the model named in the picker is not always
 * the one generating. Measuring is the only way to choose.
 *
 * ## Why three runs and a median
 *
 * Borrowed from `dsh-connect-workbuddy`'s `tps.ts`, whose measurements match
 * what this machine reproduces against AutoClaw: the SAME model varies wildly
 * between runs. Measured here 2026-11-24 on `zai_auto`:
 * 44.7 / 12.7 / 26.6 characters per second — a 3.5x spread with no config
 * change. A single run reports luck as truth; the median of three discards the
 * outlier while still costing about a third of a cent.
 *
 * ## What is measured, precisely
 *
 * `tokensPerSecond = completion_tokens / (lastContentChunk - firstContentChunk)`,
 * i.e. the generation span only. Time spent before the first content chunk is
 * reported separately as `timeToFirstTokenMs` — folding it into the rate would
 * make a model that thinks for 5 s and then writes at 100 tok/s report 20 tok/s,
 * which answers a different question than "how fast does it write".
 *
 * The count comes from the upstream's own `usage.completion_tokens` when it
 * reports one. When it does not, the token count is ESTIMATED from the text and
 * the sample is marked `estimated` — never silently presented as exact.
 *
 * @module dsh-connect-autoclaw/tps
 */

/** Output tokens per speed run. Small enough to cost little, long enough to time. */
export const TPS_PROBE_MAX_TOKENS = 256

/** Runs per model. Odd on purpose: a median of an even count averages two values. */
export const TPS_PROBE_RUNS = 3

/**
 * Smallest generation span that still means something, in ms.
 *
 * Guards the divide-by-zero when a fast model delivers everything in one burst:
 * `chunks === 1` tells us nothing about the RATE, and the run reports no speed
 * rather than an invented one.
 */
export const MIN_GENERATION_MS = 1

/**
 * The prompt asks for VOLUME, not quality, and must be answerable without
 * thinking: a model that reasons for 3 s before writing would otherwise report a
 * slow generation rate that has nothing to do with how fast it writes.
 */
const BODY = Object.freeze({
  system: 'You are a throughput benchmark. Output a long, uninterrupted sequence of short words separated by spaces. No preamble, no explanation, no code block.',
  user: 'List the numbers from 1 to 400 in words, separated by single spaces.',
})

/**
 * The request body for one speed run.
 *
 * The body is NOT assembled raw: AutoClaw answers a bare 406 to any system text
 * outside its allowlist (measured — the first version of this probe got an empty
 * 406 for exactly that). `translateRequest` is the same neutralisation the chat
 * path uses, so a speed run passes the same gate a real turn does.
 *
 * `reasoning_effort` is OMITTED rather than sent as a "do not think" spelling:
 * no catalog declares such a value, so sending one means inventing an effort
 * level and hoping every gateway tolerates it. Sending nothing cannot be
 * refused.
 *
 * @param {string} modelId
 * @param {(body: object) => object} translate - the shim's `translateRequest`
 */
export function tpsProbeRequestBody(modelId, translate) {
  const raw = {
    model: modelId,
    messages: [
      { role: 'system', content: BODY.system },
      { role: 'user', content: BODY.user },
    ],
    max_tokens: TPS_PROBE_MAX_TOKENS,
    stream: true,
  }
  return JSON.stringify(translate(raw))
}

/** Iterate the `data:` payloads of an SSE text buffer. */
function* frames(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      yield JSON.parse(payload)
    } catch { /* a partial frame at a chunk boundary; the caller re-slices */ }
  }
}

/**
 * Read one run off a stream of SSE bytes.
 *
 * Pure over the bytes it is given, so the timing logic can be tested without a
 * network: pass the chunks, get back what the stream said about itself.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<{outputTokens?: number, textChars: number, firstContentMs?: number, generationMs?: number, contentChunks: number, credit?: number, estimated: boolean}>}
 */
export async function readTpsRun(chunks, options = {}) {
  const now = options.now ?? (() => Date.now())
  const decoder = new TextDecoder()
  const startedAt = now()

  let buffer = ''
  let firstAt
  let lastAt
  let contentChunks = 0
  let textChars = 0
  let completionTokens
  let credit

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    // Keep the unterminated tail: a frame can straddle a chunk boundary.
    const cut = buffer.lastIndexOf('\n')
    if (cut < 0) continue
    const complete = buffer.slice(0, cut)
    buffer = buffer.slice(cut + 1)

    for (const frame of frames(complete)) {
      const usage = frame?.usage
      if (usage !== null && typeof usage === 'object') {
        if (typeof usage.completion_tokens === 'number') completionTokens = usage.completion_tokens
        if (typeof usage.credit === 'number') credit = usage.credit
      }
      const delta = frame?.choices?.[0]?.delta
      const text = typeof delta?.content === 'string' ? delta.content : ''
      if (text === '') continue
      const at = now()
      if (firstAt === undefined) firstAt = at
      lastAt = at
      contentChunks += 1
      textChars += text.length
    }
  }

  const estimated = completionTokens === undefined
  return {
    ...(completionTokens === undefined
      // No usage frame: approximate from text. Marked so the card can say so.
      ? { outputTokens: Math.max(0, Math.round(textChars / 4)) }
      : { outputTokens: completionTokens }),
    textChars,
    ...(firstAt === undefined ? {} : { firstContentMs: firstAt - startedAt }),
    ...(firstAt === undefined || lastAt === undefined ? {} : { generationMs: lastAt - firstAt }),
    contentChunks,
    ...(credit === undefined ? {} : { credit }),
    estimated,
  }
}

/**
 * Fold the runs of one model into the sample the picker renders.
 *
 * @param {string} modelId
 * @param {Array<Awaited<ReturnType<typeof readTpsRun>> | undefined>} runs
 *   one entry per attempt; `undefined` marks a failed run
 */
export function summariseTps(modelId, runs) {
  const usable = runs.filter((run) => run !== undefined
    && typeof run.generationMs === 'number'
    && run.generationMs >= MIN_GENERATION_MS
    && typeof run.outputTokens === 'number'
    && run.outputTokens > 0
    && run.contentChunks > 1)

  const rates = usable
    .map((run) => run.outputTokens / (run.generationMs / 1000))
    .sort((a, b) => a - b)

  const firsts = runs
    .filter((run) => run !== undefined && typeof run.firstContentMs === 'number')
    .map((run) => run.firstContentMs)
    .sort((a, b) => a - b)

  const credits = runs
    .filter((run) => run !== undefined && typeof run.credit === 'number')
    .map((run) => run.credit)

  return {
    modelId,
    samples: runs.filter((run) => run !== undefined).length,
    complete: runs.every((run) => run !== undefined),
    // Omitted rather than zero: "could not be timed" is not "was infinitely slow".
    ...(rates.length === 0 ? {} : { tokensPerSecond: rates[Math.floor(rates.length / 2)] }),
    ...(firsts.length === 0 ? {} : { timeToFirstTokenMs: firsts[Math.floor(firsts.length / 2)] }),
    ...(credits.length === 0 ? {} : { credit: credits.reduce((a, b) => a + b, 0) }),
    // Any estimated run makes the whole sample approximate.
    estimated: usable.some((run) => run.estimated === true),
    ...(rates.length === 0
      ? { reason: runs.every((run) => run === undefined) ? 'all-failed' : 'few-chunks' }
      : {}),
  }
}
