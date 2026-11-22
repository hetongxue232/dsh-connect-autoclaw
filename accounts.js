/**
 * Multi-account store: enumerate, select, pool-order, import/export.
 *
 * Two account sources:
 *   - the AutoClaw desktop app's own directories
 *     (the per-platform user-data root from credential.js: macOS Application
 *     Support, Windows %APPDATA%, Linux $XDG_CONFIG_HOME — accounts/<id>/), and
 *   - this plugin's vault (`$DSH_HOME/atuoclaw-vault/accounts/<id>.json`),
 *     where IMPORTED accounts live. The app's own files stay read-only; an
 *     imported account never migrates into them.
 *
 * Pool rules follow `dsh-connect-workbuddy`'s account pool, reduced to one
 * provider: exclude accounts a recent probe marked unavailable, then prefer
 * the earliest-expiring balance, then the larger total, then the account id —
 * the last one makes the order a total order, so the same inputs always pick
 * the same account and selection never oscillates between two rows.
 *
 * @module dsh-connect-autoclaw/accounts
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { accountsRoot, decryptSafeStorage, readStorageKey } from './credential.js'

/** Where imported accounts and the pool state live. */
export function vaultRoot(override) {
  if (typeof override === 'string' && override !== '') return override
  if (typeof process.env.AUTOCLAW_VAULT_DIR === 'string' && process.env.AUTOCLAW_VAULT_DIR.trim() !== '') {
    return process.env.AUTOCLAW_VAULT_DIR.trim()
  }
  const profileDir = process.env.DSH_PROFILE_DIR
  const home = profileDir ? dirname(dirname(profileDir)) : join(homedir(), '.dsh')
  return join(home, 'atuoclaw-vault')
}
export function vaultAccountsDir(override) {
  return join(vaultRoot(override), 'accounts')
}
export function vaultStatePath(override) {
  return join(vaultRoot(override), 'state.json')
}

/** Atomic write: temp file + rename, so a crash never truncates the state. */
async function writeJsonAtomic(path, value) {
  const text = JSON.stringify(value, null, 2)
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, path)
}

async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return undefined
  }
}

/** The pool state file. Missing or corrupt reads as the defaults. */
export async function loadState(override) {
  const parsed = await readJson(vaultStatePath(override))
  return {
    selectedAccountId: typeof parsed?.selectedAccountId === 'string' ? parsed.selectedAccountId : '',
    poolEnabled: parsed?.poolEnabled === true,
    probes: parsed?.probes !== null && typeof parsed?.probes === 'object' ? parsed.probes : {},
    probeTier: parsed?.probeTier ?? undefined,
    // Exhausted-model verdicts, so the warning survives a restart. Keyed by
    // model id; see src/quota.js for the TTL that bounds their usefulness.
    quota: parsed?.quota !== null && typeof parsed?.quota === 'object' ? parsed.quota : {},
  }
}

export async function saveState(state, override) {
  await writeJsonAtomic(vaultStatePath(override), {
    selectedAccountId: state.selectedAccountId ?? '',
    poolEnabled: state.poolEnabled === true,
    probes: state.probes ?? {},
    probeTier: state.probeTier ?? undefined,
    quota: state.quota ?? {},
  })
}

/** One account row before credentials are decrypted. */
export async function listAccounts({ accountRoot, vaultOverride } = {}) {
  const found = new Map()

  // 1. The desktop app's own account directories (newest credential first).
  const root = typeof accountRoot === 'string' && accountRoot !== ''
    ? accountRoot
    : accountsRoot()
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const credPath = join(dir, 'account-credentials.enc')
      let mtimeMs = 0
      try {
        mtimeMs = (await fs.stat(credPath)).mtimeMs
      } catch {
        continue // a directory that never signed in
      }
      let profile
      try {
        profile = JSON.parse(await fs.readFile(join(dir, 'account-profile.json'), 'utf8'))?.profile
      } catch { /* profile is display-only */ }
      found.set(entry.name, {
        source: 'app', accountId: entry.name, dir, profile, mtimeMs,
      })
    }
  } catch {
    // No app install: the vault may still hold imported accounts.
  }

  // 2. Imported accounts in this plugin's vault.
  const vaultDir = vaultAccountsDir(vaultOverride)
  try {
    for (const entry of await fs.readdir(vaultDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const parsed = await readJson(join(vaultDir, entry.name))
      if (parsed === undefined || typeof parsed.accountId !== 'string' || parsed.accountId === '') continue
      if (found.has(parsed.accountId)) continue // the app's own copy wins
      found.set(parsed.accountId, {
        source: 'vault', accountId: parsed.accountId, file: join(vaultDir, entry.name),
        profile: parsed.profile, mtimeMs: 0,
      })
    }
  } catch { /* empty vault */ }

  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.accountId.localeCompare(b.accountId))
}

/** Vault file path for one imported account id. */
function importedPath(accountId, override) {
  // The id is a hash-length hex string from the app, but NEVER trust a path
  // component: hash whatever the import carried so traversal is impossible.
  const safe = createHash('sha256').update(accountId).digest('hex').slice(0, 40)
  return join(vaultAccountsDir(override), `${safe}.json`)
}

/**
 * Merge imported accounts into the vault. Recognized fields only; a record
 * without a usable token is skipped and counted. Returns {added, updated, skipped}.
 */
export async function importAccounts(records, { vaultOverride } = {}) {
  let added = 0
  let updated = 0
  let skipped = 0
  for (const record of Array.isArray(records) ? records : []) {
    if (record === null || typeof record !== 'object') { skipped += 1; continue }
    const accountId = typeof record.accountId === 'string' ? record.accountId.trim() : ''
    const rawToken = typeof record.accessToken === 'string' ? record.accessToken.trim() : ''
    if (accountId === '' || rawToken === '') { skipped += 1; continue }
    const token = rawToken // keep whatever prefix the export carried; signedHeaders normalizes
    const existing = await readJson(importedPath(accountId, vaultOverride))
    await writeJsonAtomic(importedPath(accountId, vaultOverride), {
      schemaVersion: 1,
      accountId,
      accessToken: token,
      refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : '',
      profile: record.profile !== null && typeof record.profile === 'object' ? record.profile : {},
      importedAt: new Date().toISOString(),
      ...(existing?.importedAt !== undefined ? {} : {}),
    })
    if (existing === undefined) added += 1
    else updated += 1
  }
  return { added, updated, skipped }
}

/** Read one vault-imported account's credential bundle. */
export async function readImportedCredential(accountId, { vaultOverride } = {}) {
  const parsed = await readJson(importedPath(accountId, vaultOverride))
  if (parsed === undefined || typeof parsed.accessToken !== 'string' || parsed.accessToken === '') return undefined
  return {
    accountId: parsed.accountId,
    accessToken: parsed.accessToken,
    refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
    profile: parsed.profile ?? {},
    source: 'vault',
  }
}

/**
 * Decrypt every app account's credential with ONE Keychain-derived key
 * (safeStorage keys the app, not the account). Failures are per-account:
 * one unreadable credential never blanks the whole roster.
 */
export async function readAppCredentials(accounts, { accountRoot } = {}) {
  let key
  try {
    key = await readStorageKey()
  } catch {
    return new Map()
  }
  const out = new Map()
  for (const account of accounts) {
    if (account.source !== 'app') continue
    try {
      // `decryptSafeStorage` returns the trimmed JSON STRING; parsing it here
      // mirrors `readJsonFile` in credential.js. Treating it as an object was
      // the one defect that made every app account read as unavailable.
      const plain = decryptSafeStorage(
        await fs.readFile(join(account.dir, 'account-credentials.enc')), key)
      const parsed = JSON.parse(plain)
      const token = typeof parsed.accessToken === 'string' ? parsed.accessToken : ''
      if (token === '') continue
      out.set(account.accountId, {
        accountId: account.accountId,
        accessToken: token,
        refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
        profile: account.profile ?? {},
        source: 'app',
      })
    } catch {
      // Unreadable credential: the roster still shows the row, marked unavailable.
    }
  }
  return out
}

/**
 * The cooldown after which a failed probe stops excluding an account.
 * WorkBuddy's value, kept: 30 minutes is long enough to stop hammering a
 * dead credential and short enough that a fixed account comes back.
 */
export const PROBE_COOLDOWN_MS = 30 * 60 * 1000

/**
 * Whether a probe recorded at `at` still excludes the account.
 *
 * Two guards, both load-bearing:
 *   - only a FAILOVERABLE kind (credential / quota / rate / server / network)
 *     may bench an account. A request-class failure (400/406/413) says nothing
 *     about the credential, and a single-account setup would otherwise be
 *     taken out of service by one oversized probe body.
 *   - a legacy record with no `kind` is treated as failoverable (older builds
 *     wrote every failure), so existing state files keep working.
 * A stale record (outside the cooldown) or a success never excludes.
 */
const FAILOVERABLE_PROBE_KINDS = new Set(['credential', 'quota', 'rate', 'server', 'network'])

export function probeExcludes(probe, now = Date.now()) {
  if (probe === null || typeof probe !== 'object' || probe.ok !== false) return false
  if (typeof probe.at !== 'number' || now - probe.at >= PROBE_COOLDOWN_MS) return false
  const kind = probe.kind
  return kind === undefined || FAILOVERABLE_PROBE_KINDS.has(kind)
}

/**
 * Order the available accounts by the pool rules.
 *
 * `balances` maps accountId → { total, expiringPoints } (either may be
 * undefined when a read failed); an account with no balance data sorts after
 * the ones with data but keeps a deterministic place by id.
 */
export function orderPool(accounts, balances, now = Date.now()) {
  const withData = []
  const withoutData = []
  for (const account of accounts) {
    const balance = balances?.get?.(account.accountId)
    if (balance === undefined) { withoutData.push(account); continue }
    withData.push({ account, balance })
  }
  withData.sort((left, right) => {
    // Earliest-expiring first: spending a balance about to lapse beats
    // hoarding it (the sibling's rule, verbatim in intent).
    const expiringLeft = left.balance.expiringPoints ?? 0
    const expiringRight = right.balance.expiringPoints ?? 0
    if (expiringLeft !== expiringRight) return expiringRight - expiringLeft
    const totalLeft = left.balance.total ?? 0
    const totalRight = right.balance.total ?? 0
    if (totalLeft !== totalRight) return totalRight - totalLeft
    return left.account.accountId.localeCompare(right.account.accountId)
  })
  withoutData.sort((a, b) => a.accountId.localeCompare(b.accountId))
  return [...withData.map((row) => row.account), ...withoutData]
}

/**
 * Pick the account a request should use.
 *
 * Pool ON: exclude probed-out and explicitly excluded ids, order by the pool
 * rules, return the head. Pool OFF: the selected account, or the newest app
 * account when no selection is recorded — never a pool pick.
 */
export function pickAccount({ accounts, credentials, state, balances, exclude = [] }) {
  const available = accounts.filter((account) => credentials.has(account.accountId)
    && !exclude.includes(account.accountId)
    && !probeExcludes(state.probes?.[account.accountId]))
  if (state.poolEnabled === true) {
    const ordered = orderPool(available, balances)
    return ordered[0] ?? undefined
  }
  const selected = state.selectedAccountId !== ''
    ? available.find((account) => account.accountId === state.selectedAccountId)
    : undefined
  return selected ?? available[0]
}
