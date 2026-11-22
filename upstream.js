/**
 * AutoClaw's read-only points API.
 *
 * The gateway authenticates every call with three things at once: the session
 * bearer token, a per-request timestamp, and an MD5 signature
 * `md5(appId & timestamp & appKey)`. The app itself ships both constants
 * (`cms` in its main bundle: appId `100003`, product `autoclaw`), so they are
 * reproduced here — without them the gateway answers `410000 用户未登录` even
 * for a perfectly valid token.
 *
 * Three endpoints, all reads:
 *
 * | path | what it answers |
 * |---|---|
 * | `/agent-assetmgr/api/v2/wallets` | total balance + the five sub-wallets |
 * | `/agent-assetmgr/api/v1/points/expiring` | how much expires, and when |
 * | `/agent-assetmgr/api/v1/ledgers_std` | recent ledger entries |
 *
 * A token that expired mid-session answers `410000`; the refresh endpoint below
 * trades the stored refresh token for a new pair, in memory only.
 *
 * @module dsh-connect-autoclaw/upstream
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { accountsRoot } from './credential.js'
/** The AutoClaw client identity the gateway signs for (from its own bundle). */
export const CLIENT = Object.freeze({
  appId: '100003',
  appKey: '38d2391985e2369a5fb8227d8e6cd5e5',
  product: 'autoclaw',
  channel: 'official',
})

/** `X-Tm` is not free-form: the gateway compares it to a known platform list. */
function platformTag() {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'win'
  return process.platform
}

/** The signed header set for one request. */
export function signedHeaders({ token, version, timestamp, language = 'zh-CN' }) {
  const seconds = String(Math.floor(timestamp / 1000))
  const headers = {
    Accept: 'application/json',
    'X-Version': version,
    'X-Tm': platformTag(),
    'X-Product': CLIENT.product,
    'X-Auth-Appid': CLIENT.appId,
    'X-Auth-TimeStamp': seconds,
    'X-Auth-Sign': createHash('md5').update(`${CLIENT.appId}&${seconds}&${CLIENT.appKey}`).digest('hex'),
    'X-Lang': language,
    'X-Channel': CLIENT.channel,
  }
  const bearer = token === '' ? '' : /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`
  if (bearer !== '') headers.Authorization = bearer
  return headers
}

/** A gateway answer: the envelope's `code` decides success, not the HTTP status. */
async function callJson(url, headers, body, timeoutMs) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const parsed = await response.json().catch(() => undefined)
  return { status: response.status, body: parsed }
}

/** The app's own version, read from its bundle so an upgrade does not strand this. */
export async function appVersion(overrides) {
  const candidates = overrides?.appVersion
    ? [overrides.appVersion]
    : ['/Applications/AutoClaw2.app/Contents/Resources/app/package.json']
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8'))
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    } catch {
      // Not installed at this path; try the next one.
    }
  }
  return '2.4.2'
}

/** The device id the app registered; the refresh endpoint requires it. */
export async function readDeviceId(overrides) {
  if (overrides?.deviceId !== undefined) return overrides.deviceId
  // `Local State`/device-id.json sits at the config root, one level above
  // accounts/. Deriving it from accountsRoot() keeps every platform working
  // and honors the same AUTOCLAW_USER_DATA_ROOT override.
  const path = join(dirname(accountsRoot()), 'device', 'device-id.json')
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed.deviceId === 'string' ? parsed.deviceId : ''
  } catch {
    return ''
  }
}

/** The five sub-wallets, in upstream order, keeping the hidden ones visible to the panel. */
export function walletsOf(data) {
  const wallets = Array.isArray(data?.wallets) ? data.wallets : []
  return wallets
    .filter((wallet) => typeof wallet?.public_wallet_type === 'string')
    .map((wallet) => ({
      type: wallet.public_wallet_type,
      name: typeof wallet.display_name === 'string' ? wallet.display_name : wallet.public_wallet_type,
      balance: typeof wallet.balance === 'number' ? wallet.balance : 0,
      priority: typeof wallet.priority === 'number' ? wallet.priority : 999,
      displayed: wallet.display === true,
    }))
    .sort((left, right) => left.priority - right.priority)
}

/**
 * AutoClaw's own summary line for the expiry window.
 *
 * `expiring_points_text` is shown verbatim when present: the app formats it and
 * the wording ("3 天内到期") is the gateway's, which is the only party that knows
 * whether the window is days or hours.
 */
export function expiringOf(data) {
  if (data === undefined || data === null) return undefined
  const points = typeof data.expiring_points === 'number' ? data.expiring_points : 0
  if (points <= 0) return undefined
  const amount = typeof data.expire_time_value === 'number' ? data.expire_time_value : undefined
  const unit = typeof data.expire_time_type === 'string' ? data.expire_time_type : undefined
  return {
    points,
    total: typeof data.total_points === 'number' ? data.total_points : undefined,
    amount,
    unit,
    text: typeof data.expiring_points_text === 'string' ? data.expiring_points_text : undefined,
  }
}

/** Ledger rows, trimmed to what a panel shows. */
export function ledgersOf(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : []
  return entries.slice(0, 20).map((entry) => ({
    id: String(entry?.id ?? ''),
    amount: typeof entry?.amount === 'number' ? entry.amount : 0,
    kind: typeof entry?.mutation_type === 'string' ? entry.mutation_type : '',
    description: typeof entry?.description === 'string' ? entry.description : '',
    at: typeof entry?.metadata?.grant_date === 'string' ? entry.metadata.grant_date : undefined,
  }))
}

/**
 * The signed read wrapper.
 *
 * `onUnauthorized` is called once when the gateway answers `410000`, and its
 * return value is used as a replacement token. Nothing is persisted: a refresh
 * this process learned about must not overwrite the file the app owns.
 */
export function createUpstream({ baseURL, version, token, onUnauthorized, timeoutMs = 20000 }) {
  const base = baseURL.replace(/\/+$/, '')
  const call = async (path, query) => {
    const url = new URL(base + path)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
    let current = token
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { body } = await callJson(url.href, signedHeaders({ token: current, version, timestamp: Date.now() }), undefined, timeoutMs)
      if (body?.code === 0) return { ok: true, data: body.data }
      if (body?.code === 410000 && attempt === 0 && onUnauthorized !== undefined) {
        const next = await onUnauthorized()
        if (typeof next === 'string' && next !== '') {
          current = next
          continue
        }
      }
      return { ok: false, code: body?.code, message: typeof body?.msg === 'string' ? body.msg : `HTTP error ${body?.code ?? 'unknown'}` }
    }
    return { ok: false, code: 410000, message: '用户未登录，请重新登录' }
  }

  return {
    wallets: () => call('/agent-assetmgr/api/v2/wallets', { biz_app_id: CLIENT.product }),
    expiring: (windowSeconds = 7 * 24 * 3600) =>
      call('/agent-assetmgr/api/v1/points/expiring', { biz_app_id: CLIENT.product, window_seconds: windowSeconds }),
    ledgers: (limit = 20) => call('/agent-assetmgr/api/v1/ledgers_std', { biz_app_id: CLIENT.product, limit }),
  }
}

/** Trade a refresh token for a fresh access token. In memory only. */
export async function refreshAccessToken({ baseURL, refreshToken, deviceId, version, timeoutMs = 20000 }) {
  if (refreshToken === '') return undefined
  const url = baseURL.replace(/\/+$/, '') + '/userapi/v1/agent-refresh'
  const bare = /^Bearer\s+/i.test(refreshToken) ? refreshToken.replace(/^Bearer\s+/i, '') : refreshToken
  const headers = signedHeaders({ token: '', version, timestamp: Date.now() })
  const { body } = await callJson(url, headers, { refresh_token: bare, source_id: CLIENT.product, device_id: deviceId }, timeoutMs)
  if (body?.code !== 0) return undefined
  const token = body?.data?.access_token
  return typeof token === 'string' && token !== '' ? token : undefined
}
