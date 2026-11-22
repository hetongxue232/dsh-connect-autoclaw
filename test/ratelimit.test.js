// The per-account gate: a bounded concurrency window, a min gap between
// dispatches, and independent lanes for different accounts. Fully injected
// clock/timer, so every assertion is deterministic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountLimiter, DEFAULT_MAX_CONCURRENT } from '../src/ratelimit.js'

function harness(options = {}) {
  let clock = 1_000_000
  const waits = []
  const delay = (ms) => {
    waits.push(ms)
    // Resolve on a real microtask so the pump's `await` actually yields.
    return new Promise((resolve) => { queueMicrotask(() => { clock += ms; resolve() }) })
  }
  const limiter = createAccountLimiter({
    minIntervalMs: 0, // window behaviour first; pacing has its own tests
    delay,
    now: () => clock,
    ...options,
  })
  return { limiter, delay, waits, tick: (ms) => { clock += ms }, now: () => clock }
}

/** Let queued microtasks (and the pump's awaits) settle. */
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

test('the default window lets four callers hold a slot together', async () => {
  assert.equal(DEFAULT_MAX_CONCURRENT, 4)
  const h = harness()
  const releases = []
  for (let i = 0; i < 4; i += 1) releases.push(await h.limiter.acquire('acct'))
  assert.equal(h.limiter.snapshot('acct').active, 4)
  assert.equal(h.limiter.snapshot('acct').queued, 0)
  releases.forEach((r) => r())
  await settle()
  assert.equal(h.limiter.snapshot('acct').active, 0)
})

test('the fifth caller waits for a slot instead of overrunning the window', async () => {
  const h = harness({ maxConcurrentPerAccount: 4 })
  const releases = []
  for (let i = 0; i < 4; i += 1) releases.push(await h.limiter.acquire('acct'))

  let fifthGranted = false
  const fifth = h.limiter.acquire('acct').then((release) => { fifthGranted = true; return release })
  await settle()
  assert.equal(fifthGranted, false, 'fifth must wait while all four slots are held')
  assert.equal(h.limiter.snapshot('acct').queued, 1)

  releases[0]() // free exactly one slot
  const fifthRelease = await fifth
  assert.equal(fifthGranted, true)
  assert.equal(h.limiter.snapshot('acct').active, 4, 'freed slot was refilled, window not exceeded')
  fifthRelease()
  releases.slice(1).forEach((r) => r())
})

test('a window of 1 restores strictly-serial behaviour', async () => {
  const h = harness({ maxConcurrentPerAccount: 1 })
  const a = await h.limiter.acquire('acct')
  let bGranted = false
  const bPending = h.limiter.acquire('acct').then((r) => { bGranted = true; return r })
  await settle()
  assert.equal(bGranted, false, 'B must wait while A holds the only slot')
  a()
  const b = await bPending
  assert.equal(bGranted, true)
  b()
})

test('queued callers are granted in arrival order', async () => {
  const h = harness({ maxConcurrentPerAccount: 1 })
  const order = []
  const held = await h.limiter.acquire('acct')

  // Queue three callers while the only slot is held.
  const pending = ['first', 'second', 'third'].map((name) =>
    h.limiter.acquire('acct').then((release) => { order.push(name); return release }))
  await settle()
  assert.deepEqual(order, [], 'nobody runs while the slot is held')

  // Release and re-release one at a time; the queue must drain FIFO.
  let release = held
  for (let i = 0; i < 3; i += 1) {
    release()
    await settle()
    const justGranted = await Promise.race([pending[i], Promise.resolve(undefined)])
    assert.ok(justGranted !== undefined, `queue entry ${i} was granted`)
    release = justGranted
  }
  assert.deepEqual(order, ['first', 'second', 'third'])
  release()
})

test('the 400ms floor is applied between consecutive dispatches', async () => {
  const h = harness({ maxConcurrentPerAccount: 4, minIntervalMs: 400 })
  const r1 = await h.limiter.acquire('acct')
  r1()
  await h.limiter.acquire('acct')
  assert.deepEqual(h.waits, [400])
})

test('pacing still serialises dispatch even when slots are free', async () => {
  const h = harness({ maxConcurrentPerAccount: 4, minIntervalMs: 400 })
  // Three dispatches with a 400ms floor pay 0, 400, 400 — the window does not
  // excuse a caller from the rate ceiling.
  const r1 = await h.limiter.acquire('acct')
  r1()
  await h.limiter.acquire('acct')
  await h.limiter.acquire('acct')
  assert.deepEqual(h.waits, [400, 400])
})

test('a caller that kept the slot longer than the floor pays no extra gap', async () => {
  const h = harness({ minIntervalMs: 400 })
  const r1 = await h.limiter.acquire('acct')
  h.tick(900)
  r1()
  await h.limiter.acquire('acct')
  assert.deepEqual(h.waits, [])
})

test('different accounts are independent lanes', async () => {
  const h = harness({ maxConcurrentPerAccount: 1 })
  const a = await h.limiter.acquire('acct-1')
  const b = await h.limiter.acquire('acct-2')
  // Both resolved without waiting on each other's release.
  assert.equal(h.waits.length, 0)
  assert.equal(h.limiter.snapshot('acct-1').active, 1)
  assert.equal(h.limiter.snapshot('acct-2').active, 1)
  a()
  b()
})

test('disabled limiter is an immediate no-op', async () => {
  const h = harness({ maxConcurrentPerAccount: 1 })
  const limiter = createAccountLimiter({ enabled: false, delay: h.delay })
  const a = await limiter.acquire('acct')
  const b = await limiter.acquire('acct') // no wait even while a holds
  assert.deepEqual(h.waits, [])
  a()
  b()
})

test('release is idempotent and never over-frees the window', async () => {
  const h = harness({ maxConcurrentPerAccount: 2 })
  const a = await h.limiter.acquire('acct')
  const b = await h.limiter.acquire('acct')
  a()
  a() // second call must not free a second slot
  await settle()
  assert.equal(h.limiter.snapshot('acct').active, 1, 'only b still holds')
  b()
  await settle()
  assert.equal(h.limiter.snapshot('acct').active, 0)
})

test('a nonsense window falls back to the default instead of deadlocking', async () => {
  for (const bad of [0, -1, 1.5, Number.NaN, undefined]) {
    const h = harness({ maxConcurrentPerAccount: bad })
    const r = await h.limiter.acquire('acct')
    assert.equal(h.limiter.snapshot('acct').window, DEFAULT_MAX_CONCURRENT, `window for ${String(bad)}`)
    r()
  }
})

test('clear drops queued waiters without granting them', async () => {
  const h = harness({ maxConcurrentPerAccount: 1 })
  const held = await h.limiter.acquire('acct')
  let granted = false
  void h.limiter.acquire('acct').then(() => { granted = true })
  await settle()
  h.limiter.clear()
  await settle()
  assert.equal(granted, false)
  held()
})

test('snapshotAll reports every lane plus a total a check can act on', async () => {
  const h = harness({ maxConcurrentPerAccount: 2 })
  const a1 = await h.limiter.acquire('acct-a')
  const a2 = await h.limiter.acquire('acct-a')
  const b1 = await h.limiter.acquire('acct-b')

  // One extra caller on acct-a has nowhere to go: its window is full.
  let queuedGranted = false
  void h.limiter.acquire('acct-a').then(() => { queuedGranted = true })
  await settle()
  assert.equal(queuedGranted, false)

  const all = h.limiter.snapshotAll()
  assert.equal(all.window, 2)
  assert.equal(all.lanes['acct-a'].active, 2)
  assert.equal(all.lanes['acct-a'].queued, 1)
  assert.equal(all.lanes['acct-b'].active, 1)
  assert.equal(all.lanes['acct-b'].queued, 0)
  assert.deepEqual(all.totals, { accounts: 2, active: 3, queued: 1 })
  assert.equal(all.saturated, true, 'a queue means the window is the constraint')

  a1(); a2(); b1()
  await settle()
  const idle = h.limiter.snapshotAll()
  // The queued caller took a freed slot, so acct-a is still full but no longer backed up.
  assert.equal(idle.lanes['acct-a'].queued, 0)
})

test('snapshotAll on an untouched limiter is empty, not invented', () => {
  const h = harness({ maxConcurrentPerAccount: 4, minIntervalMs: 400 })
  const all = h.limiter.snapshotAll()
  assert.deepEqual(all.lanes, {})
  assert.deepEqual(all.totals, { accounts: 0, active: 0, queued: 0 })
  assert.equal(all.saturated, false)
  assert.equal(all.window, 4)
  assert.equal(all.interval, 400)
  assert.equal(all.enabled, true)
})

test("snapshot('*') is not the all-lanes view — that mistake reads as idle", async () => {
  const h = harness({ maxConcurrentPerAccount: 2 })
  await h.limiter.acquire('acct-a')
  // A literal lookup of "*" finds no lane; this is exactly why the route calls
  // snapshotAll instead.
  assert.equal(h.limiter.snapshot('*').active, 0)
  assert.equal(h.limiter.snapshotAll().totals.active, 1)
})
