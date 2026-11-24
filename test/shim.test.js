// The shim's request rewriting: the three upstream gates plus the loopback
// guard. Pure functions only — a unit test must not need a logged-in AutoClaw.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUIRED_BANNER,
  hostIsLoopback,
  neutralizeSystem,
  signedHeaders,
  translateRequest,
} from '../src/shim.js'

test('a bare user turn gets the banner prepended', () => {
  const out = translateRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.messages[0].role, 'system')
  assert.equal(out.messages[0].content, REQUIRED_BANNER)
  assert.equal(out.messages[1].content, 'hi')
})

test('a system message without the banner gets it, keeping its own text', () => {
  const out = translateRequest({ model: 'm', messages: [{ role: 'system', content: 'Be nice.' }] })
  assert.ok(out.messages[0].content.startsWith(REQUIRED_BANNER))
  assert.ok(out.messages[0].content.endsWith('Be nice.'))
})

test('a compliant system message is returned byte-identical', () => {
  const system = `${REQUIRED_BANNER}\n\nmy rules`
  const out = translateRequest({ model: 'm', messages: [{ role: 'system', content: system }] })
  assert.equal(out.messages[0].content, system)
})

test('every foreign identity phrase is neutralised', () => {
  for (const phrase of ['You are Claude Code', 'you are codex', "built on Anthropic's Claude Agent SDK", 'You are an interactive agent in TraeCode']) {
    const out = translateRequest({ model: 'm', messages: [{ role: 'system', content: phrase }] })
    const text = out.messages[0].content.toLowerCase()
    assert.ok(!text.includes('claude code'), phrase)
    assert.ok(!text.includes('you are codex'), phrase)
    assert.ok(!text.includes('claude agent sdk'), phrase)
    assert.ok(!text.includes('interactive agent in traecode'), phrase)
  }
})

test('client-supplied token caps are dropped, other knobs survive', () => {
  const out = translateRequest({ model: 'm', max_tokens: 100, max_completion_tokens: 50, temperature: 0.3, messages: [] })
  assert.equal(out.max_tokens, undefined)
  assert.equal(out.max_completion_tokens, undefined)
  assert.equal(out.temperature, 0.3)
})

test('a developer message becomes a system message carrying the banner', () => {
  const out = translateRequest({ model: 'm', messages: [{ role: 'developer', content: 'rules' }] })
  assert.equal(out.messages[0].role, 'system')
  assert.ok(out.messages[0].content.startsWith(REQUIRED_BANNER))
})

test('array-shaped content contributes only its text parts', () => {
  const out = translateRequest({
    model: 'm',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'array form' }, { type: 'image' }] }],
  })
  assert.ok(out.messages[0].content.endsWith('array form'))
})

test('neutralizeSystem is idempotent', () => {
  const once = neutralizeSystem('You are Claude Code, be helpful')
  assert.equal(neutralizeSystem(once), once)
})

test('the loopback guard accepts this machine and rejects a rebinding page', () => {
  assert.equal(hostIsLoopback('127.0.0.1:1234'), true)
  assert.equal(hostIsLoopback('localhost:80'), true)
  assert.equal(hostIsLoopback('[::1]:80'), true)
  assert.equal(hostIsLoopback('localhost.evil.example'), false)
  assert.equal(hostIsLoopback('10.0.0.1'), false)
  assert.equal(hostIsLoopback(''), false)
})

test('signed headers carry the vendor constants and a fresh md5 signature', () => {
  const headers = signedHeaders('abc', { now: 1_700_000_000_000 })
  assert.equal(headers['X-Auth-Appid'], '100003')
  assert.equal(headers['X-Auth-TimeStamp'], '1700000000')
  assert.equal(headers.Authorization, 'Bearer abc')
  assert.match(headers['X-Auth-Sign'], /^[0-9a-f]{32}$/)
})

// ---- model fallback on a spent allowance -------------------------------
//
// The shim is an HTTP server, so this drives it end to end against a fake
// gateway: one model answers 403/810000, the next answers 200. What is under
// test is the chain, not the wire format.

const { createShim } = await import('../src/shim.js')
const { createServer } = await import('node:http')

/** A gateway that spends `spent` and serves everything else. */
async function fakeGateway(spent, served = []) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* keep {} */ }
      const model = body?.model ?? ''
      if (spent.includes(model)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 810000, message: `${model} 免费额度已用完` }))
        return
      }
      served.push(model)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: `served by ${model}` } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

const credential = { accountId: 'a', accessToken: 'Bearer token', refreshToken: 'r' }

async function shimAgainst(gatewayPort, options = {}) {
  const shim = createShim({
    baseURL: `http://127.0.0.1:${gatewayPort}`,
    getAccount: async () => credential,
    ...options,
  })
  await shim.ready
  return shim
}

function chatThrough(shim, model, extra = {}) {
  return fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
}

test('a spent model is recorded and the request is served by the next model', async () => {
  const spentOn = []
  const served = []
  const gateway = await fakeGateway(['zaicoding_glm-5.3'], served)
  const shim = await shimAgainst(gateway.port, {
    onQuotaExhausted: (model, detail) => spentOn.push([model, detail.code]),
    nextFallback: (failed) => (failed === 'zaicoding_glm-5.3' ? 'zai_auto' : undefined),
  })
  try {
    const response = await chatThrough(shim, 'zaicoding_glm-5.3')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.choices[0].message.content, 'served by zai_auto')
    assert.deepEqual(spentOn, [['zaicoding_glm-5.3', '810000']])
    assert.deepEqual(served, ['zai_auto'])
  } finally {
    await shim.close()
    gateway.server.close()
  }
})

test('with no usable fallback the request fails and names the model', async () => {
  const gateway = await fakeGateway(['zaicoding_glm-5.3'])
  const shim = await shimAgainst(gateway.port, {
    onQuotaExhausted: () => {},
    nextFallback: () => undefined,
  })
  try {
    const response = await chatThrough(shim, 'zaicoding_glm-5.3')
    const body = await response.json()
    // 402, not the upstream's 403: see the dedicated regression test below for
    // why passing 403 through made DSH render it as "API 密钥无效".
    assert.equal(response.status, 402)
    assert.ok(body.error.message.includes('zaicoding_glm-5.3'))
    assert.ok(body.error.message.includes('额度已用完'))
  } finally {
    await shim.close()
    gateway.server.close()
  }
})

test('a silent upstream trips the FIRST-BYTE layer, and failover is free to try', async () => {
  // A gateway that accepts the request and never sends headers. Layer 1 (30 s
  // by default, 300 ms here) should cut it, and because "no acknowledgement in
  // N seconds" is a property of that upstream — not of the request — the shim
  // must be allowed to fail over. With a single account the attempts run out
  // and the 504 names the model and the wait.
  const silent = createServer(() => { /* never respond */ })
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const shim = await shimAgainst(silent.address().port, { firstByteDeadlineMs: 300 })
  try {
    const started = Date.now()
    const response = await chatThrough(shim, 'zai_auto')
    const body = await response.json()
    const elapsed = Date.now() - started
    assert.equal(response.status, 504)
    assert.equal(body.error.type, 'upstream_first_byte_timeout', 'layer 1, not the total cap')
    assert.ok(body.error.message.includes('zai_auto'))
    assert.ok(body.error.message.includes('首包'), 'the message says which layer fired')
    // Three attempts at 300 ms each, plus overhead — nowhere near 300 s.
    assert.ok(elapsed < 10_000, `answered in ${elapsed}ms`)
  } finally {
    await shim.close()
    silent.closeAllConnections?.()
    silent.close()
  }
})

test('the TOTAL layer reports its own type, distinct from first-byte', async () => {
  // Headers arrive promptly, then the body stalls forever. Layer 1 is already
  // satisfied, so only the total cap can end this — and it must say so, because
  // "upstream is slow mid-answer" is a different fact from "upstream never acked".
  const stalling = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"partial":')
    // Never end the body.
  })
  await new Promise((resolve) => stalling.listen(0, '127.0.0.1', resolve))
  const shim = await shimAgainst(stalling.address().port, {
    firstByteDeadlineMs: 5_000,
    totalDeadlineMs: 400,
  })
  try {
    const started = Date.now()
    const response = await chatThrough(shim, 'zai_auto')
    // Reading may reject (the socket is destroyed mid-body) or return the
    // partial bytes; either is a correct cut, so accept both.
    const text = await response.text().catch(() => '')
    const elapsed = Date.now() - started
    // The stream is cut mid-body: the client sees a truncated payload, never a
    // complete answer it did not receive.
    assert.ok(!text.includes('"complete"'), 'no fabricated completion')
    assert.ok(elapsed < 10_000, `capped in ${elapsed}ms`)
  } finally {
    await shim.close()
    stalling.closeAllConnections?.()
    stalling.close()
  }
})

test('a model already known to be spent is skipped before any upstream call', async () => {
  // Without `initialModel` the shim always tried the requested model first, so
  // every repeat of a spent model paid a full round-trip to re-learn what the
  // cache already knew. This asserts the request never reaches the gateway for
  // a model already on the blocklist.
  const seen = []
  const gateway = await fakeGateway([], seen)
  const shim = await shimAgainst(gateway.port, {
    onQuotaExhausted: () => {},
    initialModel: (requested) => (requested === 'spent-model' ? 'good-model' : requested),
    nextFallback: () => undefined,
  })
  try {
    const response = await chatThrough(shim, 'spent-model')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.choices[0].message.content, 'served by good-model')
    // The spent model must never appear in the gateway's traffic.
    assert.deepEqual(seen, ['good-model'])
  } finally {
    await shim.close()
    gateway.server.close()
  }
})

test('initialModel returning the same id changes nothing', async () => {
  const seen = []
  const gateway = await fakeGateway([], seen)
  const shim = await shimAgainst(gateway.port, {
    onQuotaExhausted: () => {},
    initialModel: (requested) => requested,
    nextFallback: () => undefined,
  })
  try {
    const response = await chatThrough(shim, 'zai_auto')
    assert.equal(response.status, 200)
    assert.deepEqual(seen, ['zai_auto'])
  } finally {
    await shim.close()
    gateway.server.close()
  }
})

test('a spent allowance answers 402, not the upstream 403 that reads as AUTH', async () => {
  // DSH classifies a model failure by regexing the MESSAGE for 401/403 and
  // calling it AUTH, which the UI renders as "API 密钥无效". AutoClaw reports a
  // spent model quota as 403 + {"code":810000,"message":"…额度已用完…"}, so
  // passing that status through told the user their key was invalid while the
  // real cause was quota. 402 (Payment Required) is the honest status and
  // carries none of the tokens that trigger the misclassification.
  const gateway = await fakeGatewayQuota()
  const shim = await shimAgainst(gateway.port, {
    onQuotaExhausted: () => {},
    nextFallback: () => undefined, // no fallback: the raw failure must surface
  })
  try {
    const response = await chatThrough(shim, 'zai_glm-x-preview')
    const body = await response.json()
    assert.equal(response.status, 402, 'not 403')
    assert.equal(body.error.type, 'insufficient_quota')
    // The English keyword DSH's isQuotaExceededError looks for, since the
    // gateway's own sentence is Chinese and matches nothing.
    assert.match(body.error.message, /insufficient[\s_-]+quota/i)
    // The token that would make DSH say AUTH must not lead the message.
    const leading = /^[45]\d\d\b/.exec(body.error.message)?.[0]
    assert.notEqual(leading, '403')
    assert.equal(/\b(?:401|403)\b/.test(leading ?? body.error.message), false)
  } finally {
    await shim.close()
    gateway.server.close()
  }
})

/** A gateway that answers every call with AutoClaw's spent-allowance shape. */
async function fakeGatewayQuota() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 810000, message: 'GLM-5.4 免费额度已用完,开通连续包月会员继续使用' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}
