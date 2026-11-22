import test from 'node:test'
import assert from 'node:assert/strict'
import { ledgersOf, expiringOf, walletsOf, signedHeaders, CLIENT } from '../src/upstream.js'
import { decryptSafeStorage } from '../src/credential.js'
import { hostIsLoopback, originIsLoopback } from '../src/loopback.js'

test('wallets keep upstream priority order and every sub-wallet', () => {
  const parsed = walletsOf({
    wallets: [
      { public_wallet_type: 'other', display_name: '其他积分', balance: 0, priority: 50, display: false },
      { public_wallet_type: 'reward', display_name: '奖励积分', balance: 5000, priority: 10, display: true },
    ],
  })
  assert.deepEqual(
    parsed.map((wallet) => [wallet.type, wallet.balance]),
    [
      ['reward', 5000],
      ['other', 0],
    ],
  )
})

test('wallets survives a malformed payload instead of throwing', () => {
  assert.deepEqual(walletsOf(undefined), [])
  assert.deepEqual(walletsOf({ wallets: 'nope' }), [])
})

test('expiring is absent at zero, present with the gateway wording otherwise', () => {
  assert.equal(expiringOf({ expiring_points: 0 }), undefined)
  const view = expiringOf({ expiring_points: 5000, total_points: 5000, expire_time_value: 3, expire_time_type: 'day', expiring_points_text: '5,000积分将于3天内到期' })
  assert.equal(view.points, 5000)
  assert.equal(view.unit, 'day')
  assert.match(view.text, /3天内到期/)
})

test('ledgers are capped and tolerate missing metadata', () => {
  const rows = ledgersOf({ entries: [{ id: 1, amount: 5000, mutation_type: 'credit', description: '每周限时激励' }] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '1')
  assert.equal(rows[0].at, undefined)
})

test('headers carry the signature the gateway demands', () => {
  const headers = signedHeaders({ token: 'abc', version: '2.4.2', timestamp: 1_700_000_000_000 })
  assert.equal(headers['X-Auth-Appid'], CLIENT.appId)
  assert.equal(headers['X-Auth-TimeStamp'], '1700000000')
  assert.match(headers['X-Auth-Sign'], /^[0-9a-f]{32}$/)
  assert.equal(headers.Authorization, 'Bearer abc')
  assert.equal(headers['X-Tm'], process.platform === 'darwin' ? 'mac' : headers['X-Tm'])
})

test('an already-bearer token is not double-prefixed', () => {
  assert.equal(signedHeaders({ token: 'Bearer abc', version: '2.4.2', timestamp: 0 }).Authorization, 'Bearer abc')
})

test('loopback guard accepts this machine and refuses a rebinding host', () => {
  assert.equal(hostIsLoopback('127.0.0.1:55844'), true)
  assert.equal(hostIsLoopback('localhost:55844'), true)
  assert.equal(hostIsLoopback('[::1]:55844'), true)
  assert.equal(hostIsLoopback('evil.example:55844'), false)
  assert.equal(hostIsLoopback(''), false)
  assert.equal(originIsLoopback(undefined), true)
  assert.equal(originIsLoopback('http://127.0.0.1:55844'), true)
  assert.equal(originIsLoopback('https://evil.example'), false)
})

test('safeStorage refuses a scheme macOS never produces', () => {
  assert.throws(() => decryptSafeStorage(Buffer.from('v11' + '0'.repeat(16)), Buffer.alloc(16)), /unsupported safeStorage scheme/)
})
