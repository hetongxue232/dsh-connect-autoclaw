// The upstream client: pooled keep-alive, a fetch-shaped response, and abort
// handling. Driven against a local http server so no account is needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPool, requestWithPool, POOL_DEFAULTS } from '../src/upstream-client.js'

/** A gateway that records each request's socket and can delay or hang. */
async function fakeGateway(handler) {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body: raw, socket: req.socket.remotePort })
      handler(req, res, raw)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/chat` }
}

test('the pool defaults describe a chat workload, not a crawler', () => {
  assert.equal(POOL_DEFAULTS.keepAlive, true)
  assert.equal(POOL_DEFAULTS.maxSockets, 16)
  assert.ok(POOL_DEFAULTS.keepAliveMsecs >= 10_000, 'a warm socket must outlive the gap between turns')
  assert.ok(POOL_DEFAULTS.maxFreeSockets <= POOL_DEFAULTS.maxSockets)
})

test('a second request reuses the socket the first one opened', async () => {
  const gw = await fakeGateway((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  const pool = createPool()
  try {
    const first = await requestWithPool(gw.url, { pool, headers: { 'content-type': 'application/json' }, body: '{}' })
    await first.text()
    const second = await requestWithPool(gw.url, { pool, headers: { 'content-type': 'application/json' }, body: '{}' })
    await second.text()

    assert.equal(first.reusedSocket, false, 'the first request must build the connection')
    assert.equal(second.reusedSocket, true, 'the second must ride the same socket')
    // The server sees one peer port for both — the strongest evidence.
    assert.equal(gw.seen[0].socket, gw.seen[1].socket)
    assert.ok(pool.stats().https.free >= 0)
  } finally {
    pool.destroy()
    gw.server.close()
  }
})

test('the response answers the fetch surface the shim reads', async () => {
  const gw = await fakeGateway((req, res) => {
    res.writeHead(201, { 'content-type': 'text/event-stream', 'x-request-id': 'abc123' })
    res.end('data: {"x":1}\n\n')
  })
  const pool = createPool()
  try {
    const res = await requestWithPool(gw.url, { pool, body: '{}' })
    assert.equal(res.ok, true, '201 counts as ok')
    assert.equal(res.status, 201)
    // Case-insensitive lookup, whichever case the caller asks in.
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    assert.equal(res.headers.get('Content-Type'), 'text/event-stream')
    assert.equal(res.headers.get('x-request-id'), 'abc123')
    assert.equal(res.headers.get('missing'), null)
    assert.equal(await res.text(), 'data: {"x":1}\n\n')
  } finally {
    pool.destroy()
    gw.server.close()
  }
})

test('a non-2xx is reported, not thrown — the shim classifies it itself', async () => {
  const gw = await fakeGateway((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 810000, message: 'quota' }))
  })
  const pool = createPool()
  try {
    const res = await requestWithPool(gw.url, { pool, body: '{}' })
    assert.equal(res.ok, false)
    assert.equal(res.status, 403)
    assert.ok((await res.text()).includes('810000'))
  } finally {
    pool.destroy()
    gw.server.close()
  }
})

test('an aborted signal rejects instead of hanging', async () => {
  const gw = await fakeGateway(() => { /* never answers */ })
  const pool = createPool()
  try {
    const ctrl = new AbortController()
    const pending = requestWithPool(gw.url, { pool, body: '{}', signal: ctrl.signal })
    setTimeout(() => ctrl.abort(new Error('deadline')), 50)
    await assert.rejects(pending)
  } finally {
    pool.destroy()
    gw.server.closeAllConnections?.()
    gw.server.close()
  }
})

test('an already-aborted signal rejects without opening a connection', async () => {
  const gw = await fakeGateway((req, res) => { res.writeHead(200); res.end('x') })
  const pool = createPool()
  try {
    const ctrl = new AbortController()
    ctrl.abort(new Error('pre-aborted'))
    await assert.rejects(requestWithPool(gw.url, { pool, body: '{}', signal: ctrl.signal }))
    assert.equal(gw.seen.length, 0, 'no request should have reached the server')
  } finally {
    pool.destroy()
    gw.server.close()
  }
})

test('a refused connection rejects with the transport error', async () => {
  const pool = createPool()
  try {
    // Port 1 on loopback is closed; the failure must surface, not hang.
    await assert.rejects(
      requestWithPool('http://127.0.0.1:1/chat', { pool, body: '{}' }),
      (error) => error.code === 'ECONNREFUSED' || error.code === 'EACCES',
    )
  } finally {
    pool.destroy()
  }
})

test('destroying the pool closes idle sockets', async () => {
  const gw = await fakeGateway((req, res) => { res.writeHead(200); res.end('x') })
  const pool = createPool()
  try {
    const res = await requestWithPool(gw.url, { pool, body: '{}' })
    await res.text()
    assert.equal(pool.stats().http.free, 1, 'one idle socket is held for reuse')
    pool.destroy()
    // Socket teardown is asynchronous: the agent drops the entry when the
    // close completes, so give the event loop a turn before asserting.
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(pool.stats().http.free, 0)
  } finally {
    gw.server.close()
  }
})
