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

test('two foreign phrases in one system text are both replaced without mangling the rest', () => {
  // Regression: the search offset used to be computed once, so the second
  // replacement sliced a stale span and wrote over the neighbouring words.
  const out = neutralizeSystem('You are Claude Code. You are Codex. Be terse.')
  const body = out.slice(out.indexOf(REQUIRED_BANNER) + REQUIRED_BANNER.length).trim()
  assert.equal(body, 'you are AutoClaw. you are AutoClaw. Be terse.')
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
    assert.equal(response.status, 403)
    assert.ok(body.error.message.includes('zaicoding_glm-5.3'))
    assert.ok(body.error.message.includes('额度已用完'))
  } finally {
    await shim.close()
    gateway.server.close()
  }
})
