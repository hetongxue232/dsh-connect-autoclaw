/**
 * Per-account request gate: one in-flight request per account, and a minimum
 * gap between consecutive dispatches.
 *
 * Borrowed from `dsh-providers-hub`'s "single-account rate limit": holding the
 * slot until the response finishes stops a second request from piling onto a
 * credential that is already busy, and the 400 ms floor keeps a burst of fast
 * 200s from tripping the gateway's throttle. Different accounts are independent
 * — the pool exists so other accounts can serve while one is held.
 *
 * `acquire` resolves to a release function; callers MUST call it on every exit
 * path (the shim does so in a `finally`). No timers are created when disabled.
 *
 * @module dsh-connect-autoclaw/ratelimit
 */

/**
 * @param options.minIntervalMs - minimum gap between dispatches (default 400).
 * @param options.enabled - false turns the gate into a no-op.
 * @param options.delay - injectable timer for tests.
 * @param options.now - injectable clock for tests.
 */
export function createAccountLimiter({
  minIntervalMs = 400,
  enabled = true,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  /** accountId -> { tail: Promise that resolves when the holder releases, lastDispatch } */
  const lanes = new Map()

  const laneOf = (accountId) => {
    let lane = lanes.get(accountId)
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), lastDispatch: 0 }
      lanes.set(accountId, lane)
    }
    return lane
  }

  return {
    async acquire(accountId) {
      if (!enabled) return () => {}

      const lane = laneOf(accountId)
      const predecessor = lane.tail

      // The grant hand-off is split in two: `granted` resolves when this caller
      // owns the slot, `held` resolves only when it calls release(). Chaining
      // `held` as the lane's new tail is what serialises the next caller.
      let grant
      const granted = new Promise((resolve) => { grant = resolve })
      let unblock
      const held = granted.then(() => new Promise((resolve) => { unblock = resolve }))
      lane.tail = held

      await predecessor
      const gap = minIntervalMs - (now() - lane.lastDispatch)
      if (gap > 0) await delay(gap)
      lane.lastDispatch = now()
      grant()

      let released = false
      return () => {
        if (released) return
        released = true
        unblock?.()
      }
    },

    clear() {
      lanes.clear()
    },
  }
}
