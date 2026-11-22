// The pool's pure decision layer: ordering, exclusion, failover classes.
// No filesystem, no Keychain — a unit test must not need either.
import test from 'node:test'
import assert from 'node:assert/strict'
import { orderPool, pickAccount, probeExcludes } from '../src/accounts.js'
import { classifyFailure, isFailoverable } from '../src/shim.js'

const account = (id) => ({ accountId: id, source: 'app' })

test('pool order: earliest-expiring first, then total, then id', () => {
  const balances = new Map([
    ['a', { total: 100, expiringPoints: 0 }],
    ['b', { total: 50, expiringPoints: 300 }],
    ['c', { total: 50, expiringPoints: 0 }],
  ])
  const ordered = orderPool([account('a'), account('b'), account('c')], balances)
  assert.deepEqual(ordered.map((row) => row.accountId), ['b', 'a', 'c'])
})

test('pool order: accounts without balance data keep a deterministic tail', () => {
  const balances = new Map([['b', { total: 10, expiringPoints: 0 }]])
  const ordered = orderPool([account('z'), account('b'), account('a')], balances)
  assert.deepEqual(ordered.map((row) => row.accountId), ['b', 'a', 'z'])
})

test('pickAccount with pool on skips probed-out and excluded accounts', () => {
  const accounts = [account('a'), account('b')]
  const credentials = new Map([
    ['a', { accountId: 'a', accessToken: 'Bearer a' }],
    ['b', { accountId: 'b', accessToken: 'Bearer b' }],
  ])
  const now = Date.now()
  const state = {
    poolEnabled: true,
    selectedAccountId: '',
    probes: { a: { ok: false, kind: 'quota', at: now - 1000 } },
  }
  const picked = pickAccount({ accounts, credentials, state, balances: new Map(), exclude: [] })
  assert.equal(picked.accountId, 'b')
  // A STALE probe excludes nothing: the account comes back after the cooldown.
  const stale = {
    poolEnabled: true, selectedAccountId: '',
    probes: { a: { ok: false, kind: 'quota', at: now - 31 * 60 * 1000 } },
  }
  assert.equal(probeExcludes(stale.probes.a, now), false)
  const recovered = pickAccount({ accounts, credentials, state: stale, balances: new Map(), exclude: [] })
  assert.equal(recovered.accountId, 'a')
})

test('pickAccount with pool off serves the selection, never a pool pick', () => {
  const accounts = [account('a'), account('b')]
  const credentials = new Map([
    ['a', { accountId: 'a', accessToken: 'Bearer a' }],
    ['b', { accountId: 'b', accessToken: 'Bearer b' }],
  ])
  const state = { poolEnabled: false, selectedAccountId: 'b', probes: {} }
  const picked = pickAccount({ accounts, credentials, state, balances: new Map(), exclude: [] })
  assert.equal(picked.accountId, 'b')
})

test('failure classes split exactly along failover-worthiness', () => {
  assert.equal(classifyFailure(401, ''), 'credential')
  assert.equal(classifyFailure(401, '{"code":401001,"message":"Invalid token"}'), 'credential')
  assert.equal(classifyFailure(403, '{"code":810000,"message":"额度已用完"}'), 'quota')
  assert.equal(classifyFailure(403, '{"code":810002,"message":"请求过于频繁"}'), 'rate')
  assert.equal(classifyFailure(500, ''), 'server')
  assert.equal(classifyFailure(400, '{"message":"非法模型"}'), 'request')
  assert.equal(classifyFailure(406, ''), 'request')
  for (const kind of ['credential', 'quota', 'rate', 'server']) assert.equal(isFailoverable(kind), true)
  for (const kind of ['request', 'network-down-not']) assert.equal(isFailoverable(kind), false)
})

test('readAppCredentials parses the safeStorage STRING, not a buffer-as-object', async () => {
  // A fixture would need a real Keychain-derived key, so this pins the shape
  // contract instead: decryptSafeStorage must answer a string, and the reader
  // must parse it. On a machine without AutoClaw the roster is simply empty.
  const { decryptSafeStorage } = await import('../src/credential.js')
  const { listAccounts, readAppCredentials } = await import('../src/accounts.js')
  const accounts = await listAccounts()
  const credentials = await readAppCredentials(accounts)
  for (const credential of credentials.values()) {
    assert.equal(typeof credential.accessToken, 'string')
    assert.ok(credential.accessToken.length > 0)
    assert.equal(credential.source, 'app')
  }
  // The pure helper itself: a v10 string round-trip check without a key is not
  // possible, so assert the documented return type on a thrown input instead.
  assert.throws(() => decryptSafeStorage(Buffer.from('v11'), Buffer.alloc(16)), /unsupported safeStorage scheme/)
})

test('a request-class probe failure does NOT bench the only account', () => {
  const now = Date.now()
  const accounts = [account('a')]
  const credentials = new Map([['a', { accountId: 'a', accessToken: 'Bearer a' }]])
  const state = {
    poolEnabled: false, selectedAccountId: 'a',
    probes: { a: { ok: false, kind: 'request', status: 413, at: now - 1000 } },
  }
  // The guard itself says this record does not exclude.
  assert.equal(probeExcludes(state.probes.a, now), false)
  // And the picker therefore still serves the account (the v2.4.1 defect:
  // one oversized probe body took the single-account provider offline).
  const picked = pickAccount({ accounts, credentials, state, balances: new Map(), exclude: [] })
  assert.equal(picked?.accountId, 'a')
  // A genuine credential failure inside the cooldown still excludes.
  assert.equal(probeExcludes({ ok: false, kind: 'credential', at: now - 1000 }, now), true)
  // A legacy record with no kind keeps its old behaviour.
  assert.equal(probeExcludes({ ok: false, at: now - 1000 }, now), true)
})
