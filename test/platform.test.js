// Cross-platform credential decryption: three REAL cipher round-trips built
// with node:crypto, so the Windows/Linux legs are exercised on this Mac too.
// No filesystem, no Keychain, no DPAPI — the key is injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { decryptSafeStorage, configRootsFor } from '../src/credential.js'

const SALT = 'saltysalt'
const IV = Buffer.alloc(16, ' ')
const PLAIN = JSON.stringify({ accessToken: 'Bearer test-token-abc', refreshToken: 'r', updatedAt: '2026-11-16' })

function cbcPayload(plain, key, prefix = 'v10') {
  const cipher = createCipheriv('aes-128-cbc', key, IV)
  return Buffer.concat([Buffer.from(prefix, 'latin1'), cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
}
function gcmPayload(plain, key, prefix = 'v10') {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
  return Buffer.concat([Buffer.from(prefix, 'utf8'), nonce, ciphertext, cipher.getAuthTag()])
}

test('macOS v10 AES-128-CBC with 1003-round PBKDF2 key', () => {
  const key = pbkdf2Sync(Buffer.from('keychain-password'), SALT, 1003, 16, 'sha1')
  const out = JSON.parse(decryptSafeStorage(cbcPayload(PLAIN, key), key, 'darwin'))
  assert.equal(out.accessToken, 'Bearer test-token-abc')
})

test('Linux v10 and v11 AES-128-CBC with 1-round PBKDF2 key', () => {
  const key = pbkdf2Sync(Buffer.from('peanuts'), SALT, 1, 16, 'sha1')
  for (const prefix of ['v10', 'v11']) {
    const out = JSON.parse(decryptSafeStorage(cbcPayload(PLAIN, key, prefix), key, 'linux'))
    assert.equal(out.accessToken, 'Bearer test-token-abc')
  }
})

test('Windows v10 AES-256-GCM with a 32-byte DPAPI-unwrapped key', () => {
  const key = randomBytes(32)
  const out = JSON.parse(decryptSafeStorage(gcmPayload(PLAIN, key), key, 'win32'))
  assert.equal(out.accessToken, 'Bearer test-token-abc')
})

test('Windows rejects a wrong key, a tampered tag, and a short blob', () => {
  const key = randomBytes(32)
  assert.throws(() => decryptSafeStorage(gcmPayload(PLAIN, key), randomBytes(32), 'win32'))
  const bad = gcmPayload(PLAIN, key)
  bad[bad.length - 1] ^= 0xff
  assert.throws(() => decryptSafeStorage(bad, key, 'win32'))
  assert.throws(() => decryptSafeStorage(Buffer.from('v10'), key, 'win32'), /too short/)
})

test('the same v10 prefix never selects the cipher — the platform does', () => {
  const cbcKey = pbkdf2Sync(Buffer.from('x'), SALT, 1003, 16, 'sha1')
  const cbc = cbcPayload(PLAIN, cbcKey)
  assert.throws(() => decryptSafeStorage(cbc, cbcKey, 'win32')) // GCM cannot read CBC
  const gcmKey = randomBytes(32)
  const gcm = gcmPayload(PLAIN, gcmKey)
  assert.throws(() => decryptSafeStorage(gcm, gcmKey, 'darwin')) // CBC cannot read GCM
})

test('configRootsFor resolves the documented per-platform user-data roots', () => {
  const env = { APPDATA: 'C:\\Users\\yg\\AppData\\Roaming', XDG_CONFIG_HOME: '/home/yg/.config' }
  const mac = configRootsFor('darwin', env)
  assert.ok(mac[0].includes('Library/Application Support/AutoClaw-official'))
  const win = configRootsFor('win32', env)
  assert.ok(win[0].startsWith('C:\\Users\\yg\\AppData\\Roaming'))
  assert.ok(win[0].includes('AutoClaw-official'))
  const linux = configRootsFor('linux', env)
  assert.ok(linux[0].startsWith('/home/yg/.config/'))
  // An explicit override wins on every platform.
  assert.deepEqual(configRootsFor('win32', { ...env, AUTOCLAW_USER_DATA_ROOT: '/custom' }), ['/custom'])
})

test('a v11 payload is refused on macOS, where only v10 exists', () => {
  const key = pbkdf2Sync(Buffer.from('x'), SALT, 1003, 16, 'sha1')
  assert.throws(() => decryptSafeStorage(cbcPayload(PLAIN, key, 'v11'), key, 'darwin'), /unsupported safeStorage scheme "v11"/)
})
