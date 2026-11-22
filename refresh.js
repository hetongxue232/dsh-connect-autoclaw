/**
 * Proactive token refresh — refresh shortly BEFORE the credential expires,
 * instead of waiting for the gateway to answer 410000 and retrying reactively.
 *
 * Two rules keep this from ever guessing:
 *   1. No expiry claim -> no refresh. A token without a readable `exp` is left
 *      alone; the shim's existing 410000 path still covers it.
 *   2. Only memory. The desktop app owns the credential file; a token learned
 *      here is never written back to disk (same contract as upstream.js).
 *
 * Concurrent callers for the same account share one in-flight refresh, so a
 * burst of requests near expiry trades the refresh token once, not N times.
 *
 * @module dsh-connect-autoclaw/refresh
 */

/** Decode a JWT payload's `exp` (seconds), or undefined for opaque tokens. */
export function jwtExpiry(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** The best expiry claim a credential carries, in epoch ms. */
export function expiryOf(credential) {
  if (credential === null || typeof credential !== 'object') return undefined
  const fromToken = jwtExpiry(credential.accessToken)
  if (fromToken !== undefined) return fromToken
  for (const key of ['expiresAt', 'maasExpiresAt']) {
    const value = credential[key]
    if (typeof value !== 'string' || value === '') continue
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/**
 * @param options.refresh - async ({ credential }) => new access token | undefined.
 * @param options.leadMs - refresh this long before expiry (default 60 s).
 * @param options.now - injectable clock for tests.
 */
export function createTokenRefresher({
  refresh,
  leadMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const cache = new Map() // accountId -> { refreshToken, token }
  const inflight = new Map() // accountId -> Promise<token | undefined>

  /** One single-flight refresh per account; concurrent callers share it. */
  async function refreshOnce(accountId, refreshToken, credential) {
    let pending = inflight.get(accountId)
    if (pending === undefined) {
      pending = Promise.resolve()
        .then(() => refresh({ credential }))
        .then((token) => {
          if (typeof token === 'string' && token !== '') {
            cache.set(accountId, { refreshToken, token })
          }
          return typeof token === 'string' && token !== '' ? token : undefined
        })
        .catch(() => undefined)
        .finally(() => { inflight.delete(accountId) })
      inflight.set(accountId, pending)
    }
    const token = await pending
    return typeof token === 'string' && token !== ''
      ? { ...credential, accessToken: token, refreshed: true }
      : credential
  }

  async function ensureFresh(credential) {
    if (credential === null || typeof credential !== 'object') return credential
    const accountId = credential.accountId
    const refreshToken = credential.refreshToken
    if (typeof refreshToken !== 'string' || refreshToken === '') return credential

    const expiry = expiryOf(credential)
    if (expiry === undefined || expiry - now() > leadMs) return credential

    const cached = cache.get(accountId)
    if (cached !== undefined && cached.refreshToken === refreshToken) {
      return { ...credential, accessToken: cached.token, refreshed: true }
    }
    return refreshOnce(accountId, refreshToken, credential)
  }

  /**
   * Refresh regardless of the local expiry claim.
   *
   * `ensureFresh` trusts the token's own `exp`, and that is not enough: the
   * gateway also revokes tokens out of band (a re-login, another client, a
   * server-side rotation), so a token that still looks valid locally answers
   * 401 `Invalid token`. The shim calls THIS after a credential-class failure,
   * which is the only way it can tell "expired" from "revoked". A cached token
   * from an earlier refresh is reused only when it differs from the one that
   * just failed.
   */
  async function forceRefresh(credential) {
    if (credential === null || typeof credential !== 'object') return credential
    const accountId = credential.accountId
    const refreshToken = credential.refreshToken
    if (typeof refreshToken !== 'string' || refreshToken === '') return credential

    const cached = cache.get(accountId)
    if (cached !== undefined && cached.refreshToken === refreshToken && cached.token !== credential.accessToken) {
      return { ...credential, accessToken: cached.token, refreshed: true }
    }
    // Drop the stale entry so refreshOnce trades the refresh token again.
    cache.delete(accountId)
    return refreshOnce(accountId, refreshToken, credential)
  }

  return {
    ensureFresh,
    forceRefresh,
    clear() {
      cache.clear()
      inflight.clear()
    },
  }
}
