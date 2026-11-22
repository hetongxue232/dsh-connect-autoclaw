// The per-account gate: one holder at a time, a min gap between dispatches,
// and independent lanes for different accounts. Fully injected clock/timer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountLimiter } from '../src/ratelimit.js'

function harness() {
  let clock = 1_000_000
  const waits = []
  const delay = (ms) => {
    waits.push(ms)
    clock += ms
    return Promise.resolve()
  }
  const limiter = createAccountLimiter({ minIntervalMs: 400, delay, now: () => clock })
  return { limiter, delay, waits, tick: (ms) => { clock += ms }, now: () => clock }
}

test('two callers on one account never hold the slot together', async () => {
  const h = harness()
  const order = []
  const a = await h.limiter.acquire('acct')
  order.push('a-holder')
  const bPending = h.limiter.acquire('acct').then((release) => {
    order.push('b-holder')
    release()
  })
  await Promise.resolve()
  assert.ok(!order.includes('b-holder'), 'B must wait while A holds')
  a()
  await bPending
  assert.deepEqual(order, ['a-holder', 'b-holder'])
})

test('the 400ms floor is applied between consecutive dispatches', async () => {
  const h = harness()
  const r1 = await h.limiter.acquire('acct')
  r1()
  await h.limiter.acquire('acct') // second dispatch pays the gap
  assert.deepEqual(h.waits, [400])
})

test('a caller that kept the slot longer than the floor pays no extra gap', async () => {
  const h = harness()
  const r1 = await h.limiter.acquire('acct')
  h.tick(900)
  r1()
  await h.limiter.acquire('acct')
  assert.deepEqual(h.waits, [])
})

test('different accounts are independent lanes', async () => {
  const h = harness()
  const a = await h.limiter.acquire('acct-1')
  const b = await h.limiter.acquire('acct-2')
  // Both resolved without waiting on each other's release.
  assert.equal(h.waits.length, 0)
  a()
  b()
})

test('disabled limiter is an immediate no-op', async () => {
  const h = harness()
  const limiter = createAccountLimiter({ enabled: false, delay: h.delay })
  const a = await limiter.acquire('acct')
  const b = await limiter.acquire('acct') // no wait even while a holds
  assert.deepEqual(h.waits, [])
  a()
  b()
})

test('release is idempotent', async () => {
  const h = harness()
  const release = await h.limiter.acquire('acct')
  release()
  release()
  await h.limiter.acquire('acct') // lane not stuck
})
