// Output-speed measurement: the rate must describe the GENERATION span, the
// median must survive an outlier, and an untimeable run must report nothing
// rather than a fabricated number.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_GENERATION_MS,
  TPS_PROBE_MAX_TOKENS,
  TPS_PROBE_RUNS,
  readTpsRun,
  summariseTps,
  tpsProbeRequestBody,
} from '../src/tps.js'

const enc = (s) => new TextEncoder().encode(s)
/** Build an async iterable of byte chunks, as an HTTP body would arrive. */
async function* chunks(...parts) { for (const p of parts) yield enc(p) }

function contentFrame(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}
function usageFrame(tokens, credit) {
  return `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: tokens, ...(credit === undefined ? {} : { credit }) } })}\n\n`
}

/** A clock that advances by a fixed step on every read. */
function steppingClock(step = 10) {
  let t = 0
  return () => { t += step; return t }
}

test('the rate is computed over the generation span, not from request start', async () => {
  // 200 ms of "thinking" before the first content chunk must NOT be charged to
  // the rate: that is time-to-first-token, a different quantity.
  let t = 0
  const now = () => t
  const stream = chunks(
    contentFrame('a'),        // t becomes 200 after the clock read below
    contentFrame('b'),
    usageFrame(4),
  )
  // Advance the clock deliberately: first content at 200 ms, last at 300 ms.
  const read = readTpsRun(stream, {
    now: (() => {
      const steps = [0, 200, 300, 300]
      let i = 0
      return () => steps[Math.min(i++, steps.length - 1)]
    })(),
  })
  const run = await read
  assert.equal(run.outputTokens, 4, 'usage tokens are preferred over an estimate')
  assert.equal(run.firstContentMs, 200)
  assert.equal(run.generationMs, 100)
  assert.equal(run.estimated, false)
  // 4 tokens in 100 ms = 40 tok/s — NOT 4 / 300 ms.
  assert.equal(run.outputTokens / (run.generationMs / 1000), 40)
})

test('no usage frame means an ESTIMATE, marked as one', async () => {
  const run = await readTpsRun(chunks(contentFrame('12345678'), contentFrame('12345678')), {
    now: steppingClock(10),
  })
  assert.equal(run.estimated, true, 'the caller must be able to say "approximate"')
  assert.ok(run.outputTokens > 0)
})

test('a single-chunk stream reports no rate instead of an invented one', async () => {
  // Everything in one burst: the stream said nothing about RATE.
  const run = await readTpsRun(chunks(contentFrame('whole answer at once')), { now: steppingClock(10) })
  assert.equal(run.contentChunks, 1)
  const sample = summariseTps('m', [run, run, run])
  assert.equal(sample.tokensPerSecond, undefined)
  assert.equal(sample.reason, 'few-chunks')
})

test('the median survives an outlier, which a mean would not', async () => {
  // Real shape measured against AutoClaw: 93 / 131 / 146 tok/s.
  const make = (tokens, ms) => ({ outputTokens: tokens, generationMs: ms, contentChunks: 10, firstContentMs: 500, estimated: false })
  const runs = [make(100, 1000), make(300, 1000), make(105, 1000)] // 100, 300, 105 tok/s
  const sample = summariseTps('m', runs)
  assert.equal(sample.tokensPerSecond, 105, 'median, not mean (mean would be 168)')
  assert.equal(sample.samples, 3)
  assert.equal(sample.complete, true)
})

test('failed runs are reported as such, not hidden', async () => {
  const ok = { outputTokens: 100, generationMs: 1000, contentChunks: 5, firstContentMs: 100, estimated: false }
  const sample = summariseTps('m', [ok, undefined, ok])
  assert.equal(sample.samples, 2, 'two usable runs')
  assert.equal(sample.complete, false, 'a partial run says so')
  assert.equal(sample.tokensPerSecond, 100)

  const dead = summariseTps('m', [undefined, undefined, undefined])
  assert.equal(dead.tokensPerSecond, undefined)
  assert.equal(dead.reason, 'all-failed')
  assert.equal(dead.complete, false)
})

test('a zero-length generation is rejected rather than divided by', async () => {
  const run = { outputTokens: 10, generationMs: 0, contentChunks: 5, firstContentMs: 50, estimated: false }
  assert.ok(run.generationMs < MIN_GENERATION_MS)
  assert.equal(summariseTps('m', [run, run, run]).tokensPerSecond, undefined)
})

test('the request body is translated and asks for volume without thinking', () => {
  const seen = []
  const translate = (body) => { seen.push(body); return body }
  const raw = JSON.parse(tpsProbeRequestBody('zai_auto', translate))
  assert.equal(seen.length, 1, 'the body must pass through translateRequest')
  assert.equal(raw.stream, true)
  assert.equal(raw.max_tokens, TPS_PROBE_MAX_TOKENS)
  // No reasoning_effort: sending no spelling cannot be refused.
  assert.equal('reasoning_effort' in raw, false)
  assert.ok(raw.messages.some((m) => /throughput benchmark/i.test(m.content)))
})

test('the probe constants match what the docs promise', () => {
  assert.equal(TPS_PROBE_RUNS, 3, 'odd, so the median is a real middle value')
  assert.equal(TPS_PROBE_MAX_TOKENS, 256)
})
