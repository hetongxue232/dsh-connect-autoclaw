/**
 * AutoClaw (智谱 zwork) credential read — macOS / Windows / Linux.
 *
 * The desktop app keeps its session under a per-platform user-data root:
 *
 *   macOS   ~/Library/Application Support/AutoClaw-official/
 *   Windows %APPDATA%/AutoClaw-official/
 *   Linux   $XDG_CONFIG_HOME/AutoClaw-official/   (or ~/.config/…)
 *
 * and the encrypted file is
 *   <root>/accounts/<accountKey>/account-credentials.enc
 *
 * Electron's `safeStorage` is Chromium OSCrypt, and the cipher + master secret
 * differ by platform (measured in eequaled/GLMproxy's `lib/vault.js`, MIT):
 *
 *   macOS   v10 · AES-128-CBC · IV=16 spaces · key = PBKDF2-SHA1(Keychain
 *           password, "saltysalt", 1003 rounds, 16B)
 *   Windows v10 · AES-256-GCM · 12B nonce + 16B tag · key = 32B from
 *           <root>/Local State → os_crypt.encrypted_key, unwrapped by DPAPI
 *           for the current user (PowerShell, one probe per process)
 *   Linux   v10/v11 · AES-128-CBC · IV=16 spaces · key = PBKDF2-SHA1(
 *           keyring password or Chromium's "peanuts" fallback, "saltysalt",
 *           1 round, 16B)
 *
 * The `v10` prefix is shared by all three, so the PLATFORM — not the prefix —
 * selects the cipher. The file is READ, never written: a refreshed token stays
 * in this process, because the running app owns that file.
 *
 * @module dsh-connect-autoclaw/credential
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Chromium OSCrypt constants. */
const SALT = 'saltysalt'
const MACOS_ROUNDS = 1003
const LINUX_ROUNDS = 1
const KEY_BYTES = 16
const IV = Buffer.alloc(16, ' ')
/** Chromium's Linux fallback when no Secret Service keyring is reachable. */
const LINUX_DEFAULT_PASSWORD = 'peanuts'
const DPAPI_PROBE_TIMEOUT_MS = 5000

/** App user-data directory names, newest product name first. */
const APP_DIR_NAMES = ['AutoClaw-official', 'AutoClaw', 'AutoClaw-oversea-official']

/** Explicit env overrides win, so a relocated install never needs a rebuild. */
function configRoots(env = process.env, platform = process.platform) {
  const override = env.AUTOCLAW_USER_DATA_ROOT || env.AUTOCLAW_CONFIG_DIR
  if (typeof override === 'string' && override.trim() !== '') return [override.trim()]
  const home = homedir()
  if (platform === 'darwin') {
    return APP_DIR_NAMES.map((name) => join(home, 'Library', 'Application Support', name))
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
    return APP_DIR_NAMES.map((name) => join(appData, name))
  }
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/')
    ? env.XDG_CONFIG_HOME
    : join(home, '.config')
  return APP_DIR_NAMES.map((name) => join(xdg, name))
}

/** Exported for the cross-platform unit test; production uses process.platform. */
export function configRootsFor(platform, env = process.env) {
  return configRoots(env, platform)
}

/** The accounts directory of the first existing config root. */
export function accountsRoot(override) {
  if (typeof override === 'string' && override !== '') return override
  const roots = configRoots()
  for (const root of roots) {
    const accounts = join(root, 'accounts')
    if (existsSync(accounts)) return accounts
  }
  // No install here: return the preferred path so callers report "sign in to
  // the AutoClaw app" against the path the app would actually use.
  return join(roots[0], 'accounts')
}

/** The config root that owns an accounts directory (Windows: Local State lives here). */
function configRootOf(accountsDir) {
  return dirname(accountsDir)
}

// ---------------------------------------------------------------- macOS

async function readMacOsKey() {
  const { stdout } = await run(
    'security',
    ['find-generic-password', '-s', 'AutoClaw Safe Storage', '-a', 'AutoClaw Key', '-w'],
    { timeout: 30000 },
  )
  const password = stdout.replace(/\n$/, '')
  if (password === '') throw new Error('AutoClaw Keychain entry is empty')
  return pbkdf2Sync(Buffer.from(password, 'utf8'), SALT, MACOS_ROUNDS, KEY_BYTES, 'sha1')
}

// ---------------------------------------------------------------- Linux

async function readLinuxKey() {
  // A real Secret Service lookup needs a D-Bus binding this plugin does not
  // ship. Chromium's own fallback ("peanuts") is what an app gets when the
  // keyring is absent, and an explicit env makes headless installs work.
  const password = (process.env.AUTOCLAW_KEYRING_PASSWORD || '').trim() || LINUX_DEFAULT_PASSWORD
  return pbkdf2Sync(Buffer.from(password, 'utf8'), SALT, LINUX_ROUNDS, KEY_BYTES, 'sha1')
}

// ---------------------------------------------------------------- Windows

/**
 * PowerShell unwraps `os_crypt.encrypted_key` with DPAPI for the current user.
 * The Local State path rides in an env var so no path quoting reaches the
 * command line; the script prints base64 and any failure exits non-zero.
 */
const DPAPI_PS_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  'Add-Type -AssemblyName System.Security;',
  '$ls = Get-Content -Raw -LiteralPath $env:AUTOCLAW_LOCAL_STATE | ConvertFrom-Json;',
  '$raw = [Convert]::FromBase64String($ls.os_crypt.encrypted_key);',
  '$blob = $raw[5..($raw.Length-1)];',
  '$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
  'Write-Output ([Convert]::ToBase64String($key))',
].join(' ')

let cachedOsCryptKey

function decodeDpapiKey(raw) {
  try {
    const key = Buffer.from((raw || '').trim(), 'base64')
    return key.length === 32 ? key : undefined
  } catch {
    return undefined
  }
}

async function readWindowsKey(accountsDir) {
  const fromEnv = decodeDpapiKey(process.env.AUTOCLAW_DPAPI_KEY)
  if (fromEnv !== undefined) return fromEnv
  if (cachedOsCryptKey !== undefined) return cachedOsCryptKey
  const localState = join(configRootOf(accountsDir), 'Local State')
  if (!existsSync(localState)) {
    throw new Error(`AutoClaw "Local State" not found at ${localState}; sign in to the app first`)
  }
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PS_SCRIPT],
    {
      timeout: DPAPI_PROBE_TIMEOUT_MS,
      env: { ...process.env, AUTOCLAW_LOCAL_STATE: localState },
    },
  )
  const key = decodeDpapiKey(stdout)
  if (key === undefined) throw new Error('AutoClaw DPAPI key could not be unwrapped (wrong user or corrupt Local State)')
  cachedOsCryptKey = key
  return key
}

/**
 * The platform's master secret for one vault.
 *
 * `accountsDir` matters only on Windows (Local State sits beside accounts/),
 * and falls back to the discovered root so every existing no-arg caller keeps
 * working. An explicit `options.key` in readCredential bypasses this entirely.
 */
export async function readStorageKey(accountsDir) {
  const dir = typeof accountsDir === 'string' && accountsDir !== '' ? accountsDir : accountsRoot()
  if (process.platform === 'win32') return readWindowsKey(dir)
  if (process.platform === 'darwin') return readMacOsKey()
  return readLinuxKey()
}

// ---------------------------------------------------------------- ciphers

/** Trim the PKCS#7 padding tail safeStorage leaves behind, keeping valid JSON. */
function trimmedJson(plain) {
  const end = plain.lastIndexOf('}')
  return end === -1 ? plain : plain.slice(0, end + 1)
}

/** macOS / Linux: v10 (and Linux v11) AES-128-CBC with a 16-byte space IV. */
function decryptCbc(payload, key, platform) {
  if (payload.length < 3) throw new Error('encrypted payload is too short')
  const scheme = payload.subarray(0, 3).toString('latin1')
  const allowed = platform === 'linux' ? ['v10', 'v11'] : ['v10']
  if (!allowed.includes(scheme)) {
    throw new Error(`unsupported safeStorage scheme "${scheme}" (only ${allowed.join('/')} exists on ${platform})`)
  }
  const body = payload.subarray(3)
  if (body.length === 0 || body.length % 16 !== 0) throw new Error('payload is not a whole number of AES blocks')
  const decipher = createDecipheriv('aes-128-cbc', key, IV)
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  return trimmedJson(plain)
}

/** Windows: v10 + 12-byte nonce + ciphertext + 16-byte GCM tag, AES-256-GCM. */
function decryptGcm(payload, key) {
  if (payload.length < 3 + 12 + 16) throw new Error('encrypted payload is too short for Windows OSCrypt')
  const scheme = payload.subarray(0, 3).toString('utf8')
  if (scheme !== 'v10') throw new Error(`unsupported safeStorage scheme "${scheme}" (only v10 exists on win32)`)
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('AutoClaw DPAPI key is required for decryption')
  const nonce = payload.subarray(3, 15)
  const tag = payload.subarray(payload.length - 16)
  const ciphertext = payload.subarray(15, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  return trimmedJson(plain)
}

/**
 * Decrypt one safeStorage payload with the given (or current) platform's cipher.
 *
 * Returns the trimmed JSON **string** (callers `JSON.parse` it) — unchanged
 * from the original macOS-only build, so accounts.js and every test keep the
 * same contract. The platform selects the cipher, never the `v10` prefix.
 * `platform` exists so the Windows/Linux legs are testable on any host.
 */
export function decryptSafeStorage(payload, key, platform = process.platform) {
  return platform === 'win32' ? decryptGcm(payload, key) : decryptCbc(payload, key, platform)
}

/** Newest account directory that actually holds credentials. */
async function newestAccountDir(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    try {
      const info = await stat(join(dir, 'account-credentials.enc'))
      found.push({ dir, mtimeMs: info.mtimeMs })
    } catch {
      // An account directory that never signed in.
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found[0]?.dir
}

/** One decrypted file, or `undefined` when it is absent. */
async function readJsonFile(dir, name, key) {
  try {
    return JSON.parse(decryptSafeStorage(await readFile(join(dir, name)), key))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read the app's current session.
 *
 * @param options.accountRoot - accounts directory override.
 * @param options.accountDir - one specific account directory.
 * @param options.key - derived key override, so a caller can skip Keychain/DPAPI.
 */
export async function readCredential(options = {}) {
  const root = accountsRoot(options.accountRoot)
  const dir = options.accountDir ?? (await newestAccountDir(root))
  if (dir === undefined) throw new Error(`no AutoClaw account under ${root}; sign in to the AutoClaw app first`)
  const key = options.key ?? (await readStorageKey(root))
  const account = await readJsonFile(dir, 'account-credentials.enc', key)
  if (account === undefined) throw new Error('AutoClaw has no account-credentials.enc')
  const token = typeof account.accessToken === 'string' ? account.accessToken : ''
  if (token === '') throw new Error('AutoClaw credential file carries no accessToken')
  // The app keeps the model-gateway token in a SECOND file; the points API
  // answers to the account token, the chat proxy to this one.
  const maas = await readJsonFile(dir, 'maas-access-token.enc', key).catch(() => undefined)
  return {
    accountDir: dir,
    accountId: dir.split(/[\\/]/).pop(),
    accessToken: token,
    refreshToken: typeof account.refreshToken === 'string' ? account.refreshToken : '',
    maasToken: typeof maas?.accessToken === 'string' ? maas.accessToken : undefined,
    maasExpiresAt: typeof maas?.expiresAt === 'string' ? maas.expiresAt : undefined,
    updatedAt: typeof account.updatedAt === 'string' ? account.updatedAt : undefined,
  }
}

/** The app's own profile: display name, phone mask, account type. */
export async function readProfile(options = {}) {
  const root = accountsRoot(options.accountRoot)
  const dir = options.accountDir ?? (await newestAccountDir(root))
  if (dir === undefined) return undefined
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'account-profile.json'), 'utf8'))
    const profile = parsed?.profile
    if (profile === undefined) return undefined
    return {
      accountId: typeof profile.accountId === 'string' ? profile.accountId : undefined,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : undefined,
      phone: typeof profile.phone === 'string' ? profile.phone : undefined,
      email: typeof profile.email === 'string' ? profile.email : undefined,
      accountType: typeof profile.accountType === 'string' ? profile.accountType : undefined,
      enterpriseName: typeof profile.enterpriseName === 'string' ? profile.enterpriseName : undefined,
    }
  } catch {
    return undefined
  }
}
