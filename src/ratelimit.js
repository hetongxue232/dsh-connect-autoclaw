/**
 * Per-account request gate: a bounded concurrency window per account, plus a
 * minimum gap between consecutive dispatches.
 *
 * ## Why a window, not a single slot
 *
 * This used to allow exactly ONE in-flight request per account. That serialised
 * every concurrent caller behind the previous caller's *complete* response —
 * head-of-line blocking. Measured against the real gateway on 2026-11-22
 * (`zai_auto`, streaming, one account):
 *
 *   concurrency 1 → TTFB p50  623 ms
 *   concurrency 4 → TTFB p50 4331 ms   (7.0x worse)
 *   concurrency 8 → TTFB p50 13625 ms  (21.9x worse, throughput 47% lower)
 *
 * A single request was healthy; only concurrency broke it. The window keeps the
 * protection the single slot was there for (never pile unbounded work onto one
 * credential) while letting independent requests overlap, which is what the
 * upstream is actually built to serve.
 *
 * ## The interval is a separate control
 *
 * `minIntervalMs` is a *dispatch rate* ceiling, not a concurrency limit. With a
 * window wider than one it still paces dispatches (0 ms, 400 ms, 800 ms, …), so
 * a window of 4 with a 400 ms floor still costs the fourth caller ~1.2 s before
 * its request leaves. Set it to 0 when the window alone is the control you want;
 * the caller decides, this module does not silently rescale it.
 *
 * `acquire` resolves to a release function; callers MUST call it on every exit
 * path (the shim does so in a `finally`). No timers are created when disabled.
 *
 * @module dsh-connect-autoclaw/ratelimit
 */

/** Default window: enough overlap to hide upstream latency, few enough to stay polite. */
export const DEFAULT_MAX_CONCURRENT = 4

/**
 * @param options.maxConcurrentPerAccount - in-flight requests allowed per account
 *   (default 4). `1` restores the old strictly-serial behaviour.
 * @param options.minIntervalMs - minimum gap between consecutive dispatches
 *   (default 400). `0` disables pacing.
 * @param options.enabled - false turns the gate into a no-op.
 * @param options.delay - injectable timer for tests.
 * @param options.now - injectable clock for tests.
 */
export function createAccountLimiter({
  maxConcurrentPerAccount = DEFAULT_MAX_CONCURRENT,
  minIntervalMs = 400,
  enabled = true,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  // A window of 0 or a non-integer would deadlock every caller; clamp up.
  const window = Number.isSafeInteger(maxConcurrentPerAccount) && maxConcurrentPerAccount >= 1
    ? maxConcurrentPerAccount
    : DEFAULT_MAX_CONCURRENT
  const interval = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : 0

  /** accountId -> { active, lastDispatch, waiters, pumping } */
  const lanes = new Map()

  const laneOf = (accountId) => {
    let lane = lanes.get(accountId)
    if (lane === undefined) {
      lane = { active: 0, lastDispatch: 0, waiters: [], pumping: false }
      lanes.set(accountId, lane)
    }
    return lane
  }

  /**
   * Fill free slots in dispatch order.
   *
   * One pump per lane at a time: the interval `await` below yields, and a second
   * pump entering that gap would take a slot the first pump already counted.
   * `pumping` is what keeps the FIFO order intact across those yields.
   */
  const pump = async (lane) => {
    if (lane.pumping) return
    lane.pumping = true
    try {
      while (lane.active < window && lane.waiters.length > 0) {
        // Pace the dispatch itself, not the wait for a slot.
        if (interval > 0) {
          const gap = interval - (now() - lane.lastDispatch)
          if (gap > 0) await delay(gap)
        }
        // The window may have been taken while the interval was being paid.
        if (lane.active >= window || lane.waiters.length === 0) break

        const grant = lane.waiters.shift()
        lane.active += 1
        lane.lastDispatch = now()

        let released = false
        grant(() => {
          if (released) return
          released = true
          lane.active -= 1
          void pump(lane)
        })
      }
    } finally {
      lane.pumping = false
    }
  }

  return {
    async acquire(accountId) {
      if (!enabled) return () => {}

      const lane = laneOf(accountId)
      return new Promise((resolve) => {
        lane.waiters.push(resolve)
        void pump(lane)
      })
    },

    /** Drop every lane's queue without granting it (used on teardown). */
    clear() {
      for (const lane of lanes.values()) {
        lane.waiters.length = 0
        lane.active = 0
      }
      lanes.clear()
    },

    /** Read-only view for diagnostics and tests. */
    snapshot(accountId) {
      const lane = lanes.get(accountId)
      return lane === undefined
        ? { active: 0, queued: 0, window, interval }
        : { active: lane.active, queued: lane.waiters.length, window, interval }
    },

    /**
     * Every lane at once, for the diagnostics route.
     *
     * `snapshot('*')` would literally look up an account named "*" and answer
     * zeroes, which reads as "the limiter is idle" — a lie. This is the call
     * that answers "what is the gate doing right now", per account plus a total
     * that a monitoring check can compare against the window.
     */
    snapshotAll() {
      const lanesOut = {}
      let active = 0
      let queued = 0
      for (const [accountId, lane] of lanes) {
        lanesOut[accountId] = { active: lane.active, queued: lane.waiters.length }
        active += lane.active
        queued += lane.waiters.length
      }
      return {
        window,
        interval,
        enabled,
        lanes: lanesOut,
        totals: { accounts: lanes.size, active, queued },
        // The practical read: is the gate admitting calls, or is work piled up
        // behind a window that is already full?
        saturated: queued > 0,
      }
    },
  }
}
