#!/usr/bin/env node
/**
 * TTFB / 超时率 / 吞吐 压测器 —— AutoClaw shim 及任何 OpenAI 兼容端点通用。
 *
 * 口径（必须与报告一致，改动这里就要改报告）：
 *   TTFB       从发出 POST 到收到「第一个非空 body 字节」的毫秒数。
 *              SSE 下即首个 `data:` 帧；非流式下即首个字节（≈完整响应）。
 *   TTFT       仅流式有意义：首个含 `delta.content` 或 `delta.reasoning_content`
 *              的帧。本脚本记为 firstContentMs，未出现则 null。
 *   timeout    请求在 deadlineMs 内既没收到响应头也没拿到数据即计为 timeout。
 *   error      非 200、或 200 但 body 不含 `choices`/`data:` 帧。
 *   并发       `--concurrency N` 同时发出 N 个请求，测完一批再发下一批。
 *   采样       每档跑 `--rounds R` 轮，每轮 `--concurrency N` 个请求；
 *              每个指标取 p50/p90/p99（最近秩法）。
 *
 * 用法：
 *   node bench.mjs --base http://127.0.0.1:55805 --token <shim-secret> \
 *                  --model zai_auto --concurrency 4 --rounds 3 --stream
 *
 * 不带 --token 时走直连（对 https://autoglm-api.zhipuai.cn 用本插件凭据自签），
 * 便于在不同项目的 shim 之间做同一口径对比。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]
  const flag = argv.find((a) => a.startsWith(`--${name}=`))
  if (flag !== undefined) return flag.slice(name.length + 3)
  return dflt
}
const flag = (name) => argv.includes(`--${name}`)

const BASE = arg('base', 'http://127.0.0.1:55805')
const TOKEN = arg('token', '')
const MODEL = arg('model', 'zai_auto')
const CONCURRENCY = Number(arg('concurrency', '4'))
const ROUNDS = Number(arg('rounds', '3'))
const STREAM = !flag('no-stream')
const DEADLINE_MS = Number(arg('deadline', '60000'))
const PROMPT = arg('prompt', '用一句话说明你是什么模型')
const OUT = arg('out', '')
const LABEL = arg('label', BASE)

// ── 统计 ───────────────────────────────────────────────────────────────────
const pct = (sorted, p) => {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}
const stats = (values) => {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (s.length === 0) return { n: 0 }
  const sum = s.reduce((a, b) => a + b, 0)
  return {
    n: s.length,
    min: s[0],
    p50: pct(s, 50),
    p90: pct(s, 90),
    p99: pct(s, 99),
    max: s[s.length - 1],
    mean: Math.round(sum / s.length),
  }
}

// ── 单次请求 ───────────────────────────────────────────────────────────────
async function once() {
  const started = performance.now()
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, DEADLINE_MS)

  const record = {
    ttfbMs: null, firstContentMs: null, totalMs: null,
    status: null, bytes: 0, outcome: 'ok', detail: '',
  }

  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: STREAM ? 'text/event-stream' : 'application/json',
        ...(TOKEN === '' ? {} : { authorization: `Bearer ${TOKEN}` }),
      },
      body: JSON.stringify({
        model: MODEL,
        stream: STREAM,
        messages: [{ role: 'user', content: PROMPT }],
      }),
      signal: ctrl.signal,
    })
    record.status = res.status
    if (res.status !== 200) {
      const text = await res.text().catch(() => '')
      record.outcome = 'error'
      record.detail = `HTTP ${res.status}: ${text.slice(0, 160)}`
      record.totalMs = performance.now() - started
      return record
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let sawPayload = false

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (record.ttfbMs === null && value && value.byteLength > 0) {
        record.ttfbMs = performance.now() - started
      }
      record.bytes += value?.byteLength ?? 0
      buf += decoder.decode(value, { stream: true })

      if (STREAM && record.firstContentMs === null) {
        for (const line of buf.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '' || payload === '[DONE]') continue
          try {
            const frame = JSON.parse(payload)
            const delta = frame?.choices?.[0]?.delta
            if (delta && (typeof delta.content === 'string' && delta.content !== ''
              || typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '')) {
              record.firstContentMs = performance.now() - started
              break
            }
          } catch { /* partial frame, keep reading */ }
        }
      }
      if (buf.length > 1_000_000) buf = buf.slice(-1000)
    }

    if (STREAM) sawPayload = /data:\s*\{/.test(buf) || record.bytes > 0
    else sawPayload = buf.includes('"choices"')
    if (!sawPayload) {
      record.outcome = 'error'
      record.detail = `no payload (${record.bytes} bytes)`
    }
    record.totalMs = performance.now() - started
    return record
  } catch (error) {
    if (timedOut) {
      record.outcome = 'timeout'
      record.detail = `exceeded ${DEADLINE_MS}ms`
    } else {
      record.outcome = 'error'
      record.detail = String(error?.message ?? error).slice(0, 160)
    }
    record.totalMs = performance.now() - started
    return record
  } finally {
    clearTimeout(timer)
  }
}

// ── 主循环 ─────────────────────────────────────────────────────────────────
const rows = []
const wallStart = performance.now()
for (let round = 1; round <= ROUNDS; round += 1) {
  const batch = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => once()),
  )
  rows.push(...batch)
  const ok = batch.filter((r) => r.outcome === 'ok').length
  process.stderr.write(`  round ${round}/${ROUNDS}: ${ok}/${CONCURRENCY} ok\n`)
}
const wallMs = performance.now() - wallStart

const ttfb = stats(rows.map((r) => r.ttfbMs))
const ttft = stats(rows.map((r) => r.firstContentMs))
const total = stats(rows.map((r) => r.totalMs))
const okCount = rows.filter((r) => r.outcome === 'ok').length
const timeouts = rows.filter((r) => r.outcome === 'timeout').length
const errors = rows.filter((r) => r.outcome === 'error').length

const report = {
  label: LABEL,
  base: BASE,
  model: MODEL,
  stream: STREAM,
  concurrency: CONCURRENCY,
  rounds: ROUNDS,
  samples: rows.length,
  wallMs: Math.round(wallMs),
  ttfb, firstContent: ttft, total,
  ok: okCount,
  timeoutRate: +(timeouts / rows.length * 100).toFixed(2),
  errorRate: +(errors / rows.length * 100).toFixed(2),
  throughputPerSec: +(okCount / (wallMs / 1000)).toFixed(2),
  failures: rows.filter((r) => r.outcome !== 'ok').map((r) => ({ outcome: r.outcome, detail: r.detail })),
}

console.log(JSON.stringify(report, null, 2))
if (OUT !== '') {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(OUT, JSON.stringify({ report, rows }, null, 2))
  process.stderr.write(`  → ${OUT}\n`)
}
