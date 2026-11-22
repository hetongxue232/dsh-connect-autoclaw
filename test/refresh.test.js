// Proactive refresh: near-expiry tokens are swapped in memory, far-from-expiry
// and opaque tokens are left alone, and concurrent callers share one refresh.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTokenRefresher, expiryOf, jwtExpiry } from '../src/refresh.js'

function jwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `h.${payload}.s`
}

test('jwtExpiry reads exp from a JWT payload', () => {
  assert.equal(jwtExpiry(jwt(1_700_000_000)), 1_700_000_000_000)
  assert.equal(jwtExpiry('opaque-token'), undefined)
  assert.equal(jwtExpiry(undefined), undefined)
})

test('expiryOf prefers the token claim over string fields', () => {
  const cred = { accessToken: jwt(1_700_000_000), expiresAt: '2099-01-01T00:00:00Z' }
  assert.equal(expiryOf(cred), 1_700_000_000_000)
  assert.equal(expiryOf({ accessToken: 'x', maasExpiresAt: '2026-01-01T00:00:00Z' }), Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(expiryOf({ accessToken: 'x' }), undefined)
})

test('a token far from expiry is returned unchanged, no refresh', async () => {
  let calls = 0
  const refresher = createTokenRefresher({
    now: () => 1_000_000,
    refresh: async () => { calls += 1; return 'new' },
  })
  const cred = { accountId: 'a', accessToken: jwt(5000), refreshToken: 'r' }
  const out = await refresher.ensureFresh(cred)
  assert.equal(out.accessToken, cred.accessToken)
  assert.equal(calls, 0)
})

test('a token inside the lead window is refreshed in memory', async () => {
  let calls = 0
  const refresher = createTokenRefresher({
    now: () => 1_000_000,
    leadMs: 60_000,
    refresh: async () => { calls += 1; return 'fresh-token' },
  })
  // exp 1010s = 1_010_000ms, only 10s away -> inside the 60s window.
  const cred = { accountId: 'a', accessToken: jwt(1010), refreshToken: 'r' }
  const out = await refresher.ensureFresh(cred)
  assert.equal(out.accessToken, 'fresh-token')
  assert.equal(out.refreshed, true)
  assert.equal(calls, 1)
})

test('concurrent near-expiry callers share one refresh', async () => {
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  const refresher = createTokenRefresher({
    now: () => 1_000_000,
    refresh: async () => { calls += 1; await gate; return 'shared' },
  })
  const cred = { accountId: 'a', accessToken: jwt(1010), refreshToken: 'r' }
  const p1 = refresher.ensureFresh(cred)
  const p2 = refresher.ensureFresh(cred)
  release()
  const [o1, o2] = await Promise.all([p1, p2])
  assert.equal(calls, 1)
  assert.equal(o1.accessToken, 'shared')
  assert.equal(o2.accessToken, 'shared')
})

test('a failed refresh leaves the original credential usable', async () => {
  const refresher = createTokenRefresher({
    now: () => 1_000_000,
    refresh: async () => { throw new Error('network') },
  })
  const cred = { accountId: 'a', accessToken: jwt(1010), refreshToken: 'r' }
  const out = await refresher.ensureFresh(cred)
  assert.equal(out.accessToken, cred.accessToken)
})

test('opaque tokens with no expiry are never proactively refreshed', async () => {
  let calls = 0
  const refresher = createTokenRefresher({ refresh: async () => { calls += 1; return 'new' } })
  const out = await refresher.ensureFresh({ accountId: 'a', accessToken: 'opaque', refreshToken: 'r' })
  assert.equal(out.accessToken, 'opaque')
  assert.equal(calls, 0)
})

test('forceRefresh trades the token even when the local expiry claim is still in the future', async () => {
  // The gateway revokes out of band (re-login, another client, rotation), so a
  // token whose `exp` is hours away still answers 401. ensureFresh trusts exp
  // and must NOT refresh here — that is the bug forceRefresh exists for.
  let calls = 0
  const refresher = createTokenRefresher({
    now: () => 1_000_000,
    refresh: async () => { calls += 1; return `fresh-${calls}` },
  })
  const credential = { accountId: 'a', accessToken: jwt(9_999_999), refreshToken: 'r' }

  const passive = await refresher.ensureFresh(credential)
  assert.equal(passive.accessToken, credential.accessToken)
  assert.equal(calls, 0)

  const forced = await refresher.forceRefresh(credential)
  assert.equal(forced.accessToken, 'fresh-1')
  assert.equal(forced.refreshed, true)
  assert.equal(calls, 1)
})

test('forceRefresh reuses a cached token only when it differs from the rejected one', async () => {
  let calls = 0
  const refresher = createTokenRefresher({
    now: () => 1_000_000,
    refresh: async () => { calls += 1; return `fresh-${calls}` },
  })
  const credential = { accountId: 'a', accessToken: jwt(9_999_999), refreshToken: 'r' }

  const first = await refresher.forceRefresh(credential)
  assert.equal(first.accessToken, 'fresh-1')

  // Same rejected token asking again: the cached 'fresh-1' differs, so reuse it
  // instead of trading the refresh token a second time.
  const again = await refresher.forceRefresh(credential)
  assert.equal(again.accessToken, 'fresh-1')
  assert.equal(calls, 1)

  // The freshly-minted token being rejected in turn must trade again, not loop
  // on a cache hit that would never change answer.
  const rejectedFresh = await refresher.forceRefresh(first)
  assert.equal(rejectedFresh.accessToken, 'fresh-2')
  assert.equal(calls, 2)
})

test('forceRefresh without a refresh token hands the credential back untouched', async () => {
  let calls = 0
  const refresher = createTokenRefresher({ refresh: async () => { calls += 1; return 'x' } })
  const credential = { accountId: 'a', accessToken: 'opaque', refreshToken: '' }
  const out = await refresher.forceRefresh(credential)
  assert.equal(out, credential)
  assert.equal(calls, 0)
})
