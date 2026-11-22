/**
 * 并发压测 + 窗口占用采样器。
 *
 * 一边按指定并发发请求，一边以固定间隔轮询 /provider 的 limiter 字段，
 * 记录 active / queued / saturated 随时间的变化，压测结束输出时间序列。
 *
 * 用法:
 *   node bench-with-sampler.mjs --base http://127.0.0.1:62853 \
 *        --token <shim-secret> --model zai_auto --concurrency 8 --rounds 3 \
 *        --interval-ms 200 --out /tmp/window-curve.json
 *
 * 采样与压测跑在同一进程内：压测用 bench.mjs 的逻辑（内联，避免子进程开销
 * 干扰计时），采样用 setInterval 读宿主路由。
 */

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]
  const f = argv.find((a) => a.startsWith(`--${n}=`))
  return f === undefined ? d : f.slice(n.length + 3)
}

// `--base` is the CHAT origin; `--diag` is where /provider lives. They differ
// when a harness serves the shim and the diagnostics on separate ports.
const BASE = arg('base', 'http://127.0.0.1:62853')
const DIAG_BASE = arg('diag', BASE)
const TOKEN = arg('token', '')
const MODEL = arg('model', 'zai_auto')
const CONCURRENCY = Number(arg('concurrency', '8'))
const ROUNDS = Number(arg('rounds', '3'))
const SAMPLE_MS = Number(arg('interval-ms', '200'))
const DEADLINE_MS = Number(arg('deadline', '120000'))
const PROMPT = arg('prompt', '用一句话说明你是什么模型')
const OUT = arg('out', '')

const LIMITER_URL = `${DIAG_BASE}/provider`
const CHAT_URL = `${BASE}/v1/chat/completions`

// ── 采样器 ─────────────────────────────────────────────────────────────────
const samples = []
let sampling = true

async function sampleOnce() {
  const at = performance.now()
  try {
    const res = await fetch(LIMITER_URL, { signal: AbortSignal.timeout(3000) })
    const body = await res.json()
    const l = body?.limiter
    return {
      at: Math.round(at),
      window: l?.window ?? null,
      active: l?.totals?.active ?? null,
      queued: l?.totals?.queued ?? null,
      saturated: l?.saturated ?? null,
      accounts: l?.totals?.accounts ?? null,
    }
  } catch (error) {
    return { at: Math.round(at), error: String(error?.message ?? error).slice(0, 80) }
  }
}

const sampler = (async () => {
  // Sample immediately, then on a fixed cadence until testing stops.
  for (;;) {
    samples.push(await sampleOnce())
    if (!sampling) break
    await new Promise((r) => setTimeout(r, SAMPLE_MS))
  }
})()

// ── 压测（与 bench.mjs 同口径）─────────────────────────────────────────────
async function once() {
  const started = performance.now()
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, DEADLINE_MS)
  const rec = { ttfbMs: null, totalMs: null, status: null, outcome: 'ok', detail: '' }
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(TOKEN === '' ? {} : { authorization: `Bearer ${TOKEN}` }),
      },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: PROMPT }] }),
      signal: ctrl.signal,
    })
    rec.status = res.status
    if (res.status !== 200) {
      rec.outcome = 'error'
      rec.detail = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`
      return rec
    }
    const reader = res.body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (rec.ttfbMs === null && value && value.byteLength > 0) rec.ttfbMs = performance.now() - started
    }
    rec.totalMs = performance.now() - started
    return rec
  } catch (error) {
    rec.outcome = timedOut ? 'timeout' : 'error'
    rec.detail = String(error?.message ?? error).slice(0, 120)
    rec.totalMs = performance.now() - started
    return rec
  } finally {
    clearTimeout(timer)
  }
}

const rows = []
const wallStart = performance.now()
for (let round = 1; round <= ROUNDS; round += 1) {
  const batch = await Promise.all(Array.from({ length: CONCURRENCY }, () => once()))
  rows.push(...batch)
  const ok = batch.filter((r) => r.outcome === 'ok').length
  process.stderr.write(`  round ${round}/${ROUNDS}: ${ok}/${CONCURRENCY} ok\n`)
}
const wallMs = performance.now() - wallStart
sampling = false
await sampler

// ── 统计 ───────────────────────────────────────────────────────────────────
const pct = (arr, p) => {
  const s = arr.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
const ttfb = rows.map((r) => r.ttfbMs)
const total = rows.map((r) => r.totalMs)
const okCount = rows.filter((r) => r.outcome === 'ok').length

const report = {
  config: { base: BASE, diag: DIAG_BASE, model: MODEL, concurrency: CONCURRENCY, rounds: ROUNDS, sampleMs: SAMPLE_MS },
  samples: rows.length,
  wallMs: Math.round(wallMs),
  ttfb: { p50: pct(ttfb, 50), p90: pct(ttfb, 90), min: Math.min(...ttfb.filter(Number.isFinite)) },
  total: { p50: pct(total, 50), p90: pct(total, 90) },
  ok: okCount,
  timeoutRate: +(rows.filter((r) => r.outcome === 'timeout').length / rows.length * 100).toFixed(2),
  errorRate: +(rows.filter((r) => r.outcome === 'error').length / rows.length * 100).toFixed(2),
  throughputPerSec: +(okCount / (wallMs / 1000)).toFixed(2),
}

// 采样曲线摘要：窗口是否真的被打满
const valid = samples.filter((s) => s.error === undefined)
const peak = {
  active: Math.max(0, ...valid.map((s) => s.active ?? 0)),
  queued: Math.max(0, ...valid.map((s) => s.queued ?? 0)),
}
const saturatedSamples = valid.filter((s) => s.saturated === true).length
const reportCurve = {
  window: valid.at(0)?.window ?? null,
  samplesTaken: samples.length,
  peakActive: peak.active,
  peakQueued: peak.queued,
  saturatedSamples,
  saturatedRatio: valid.length === 0 ? null : +(saturatedSamples / valid.length * 100).toFixed(1),
}

console.log(JSON.stringify({ report, curve: reportCurve }, null, 2))

if (OUT !== '') {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(OUT, JSON.stringify({ report, curve: reportCurve, samples, rows }, null, 2))
  process.stderr.write(`  → ${OUT}\n`)
}
