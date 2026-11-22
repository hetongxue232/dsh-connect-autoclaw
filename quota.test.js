// The quota memory and fallback chain: the rules that stop a spent allowance
// from reading as "the plugin is broken".
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  annotateCatalog,
  fallbackChain,
  isQuotaExhausted,
  noteQuotaExhausted,
  pruneQuota,
  QUOTA_TTL_MS,
} from '../src/quota.js'

const CATALOG = ['zai_auto', 'zai_auto-fast', 'zaicoding_glm-5.3', 'zai_glm-5.3-flash']

test('a verdict marks the model and expires on its own', () => {
  const quota = {}
  noteQuotaExhausted(quota, 'zaicoding_glm-5.3', { at: 1_000, code: '810000', message: '额度已用完' })
  assert.equal(isQuotaExhausted(quota, 'zaicoding_glm-5.3', 1_100), true)
  assert.equal(isQuotaExhausted(quota, 'zaicoding_glm-5.3', 1_000 + QUOTA_TTL_MS), false)
  assert.equal(isQuotaExhausted(quota, 'zai_auto', 1_100), false)
})

test('an unknown or malformed verdict is never exhausted', () => {
  const quota = { broken: { at: 'yesterday' }, nullish: null }
  assert.equal(isQuotaExhausted(quota, 'never-seen'), false)
  assert.equal(isQuotaExhausted(quota, 'broken'), false)
  assert.equal(isQuotaExhausted(quota, 'nullish'), false)
  assert.equal(isQuotaExhausted(undefined, 'anything'), false)
})

test('the message is bounded before it can reach the browser', () => {
  const quota = new Map()
  noteQuotaExhausted(quota, 'm', { message: 'x'.repeat(5_000) })
  assert.equal(quota.get('m').message.length, 200)
})

test('an empty model id records nothing', () => {
  const quota = {}
  noteQuotaExhausted(quota, '', { at: 1 })
  assert.deepEqual(quota, {})
})

test('prune drops verdicts past the TTL and keeps the rest', () => {
  const quota = { old: { at: 0 }, fresh: { at: 10_000 } }
  // `now` sits one TTL beyond `old`, so only `old` is stale.
  pruneQuota(quota, QUOTA_TTL_MS)
  assert.equal('old' in quota, false)
  assert.equal('fresh' in quota, true)
})

test('prune also drops malformed verdicts', () => {
  const quota = { broken: { at: 'yesterday' }, nil: null }
  pruneQuota(quota, 1_000)
  assert.deepEqual(quota, {})
})

test('the chain leads with Auto, then the requested model, then the catalog', () => {
  assert.deepEqual(
    fallbackChain({ model: 'zaicoding_glm-5.3', catalog: CATALOG, preferred: 'zai_auto' }),
    ['zai_auto', 'zaicoding_glm-5.3', 'zai_auto-fast', 'zai_glm-5.3-flash'],
  )
})

test('exhausted models are skipped, and Auto is not offered twice', () => {
  const quota = { 'zaicoding_glm-5.3': { at: 1_000 }, 'zai_auto-fast': { at: 1_000 } }
  assert.deepEqual(
    fallbackChain({ model: 'zaicoding_glm-5.3', catalog: CATALOG, preferred: 'zai_auto', quota, now: 1_100 }),
    ['zai_auto', 'zaicoding_glm-5.3', 'zai_glm-5.3-flash'],
  )
})

test('asking for Auto itself puts it first, once', () => {
  assert.deepEqual(
    fallbackChain({ model: 'zai_auto', catalog: CATALOG, preferred: 'zai_auto' }),
    ['zai_auto', 'zai_auto-fast', 'zaicoding_glm-5.3', 'zai_glm-5.3-flash'],
  )
})

test('turning fallback off yields exactly the requested model, exhausted or not', () => {
  const quota = { 'zaicoding_glm-5.3': { at: 1_000 } }
  assert.deepEqual(
    fallbackChain({ model: 'zaicoding_glm-5.3', catalog: CATALOG, preferred: 'zai_auto', quota, allowFallback: false, now: 1_100 }),
    ['zaicoding_glm-5.3'],
  )
})

test('an exhausted Auto still stays in the chain as the first attempt', () => {
  const quota = { 'zai_auto': { at: 1_000 } }
  assert.deepEqual(
    fallbackChain({ model: 'zaicoding_glm-5.3', catalog: CATALOG, preferred: 'zai_auto', quota, now: 1_100 }),
    ['zaicoding_glm-5.3', 'zai_auto-fast', 'zai_glm-5.3-flash'],
  )
})

test('an empty catalog still returns the requested model', () => {
  assert.deepEqual(fallbackChain({ model: 'solo', catalog: [], preferred: 'zai_auto' }), ['zai_auto', 'solo'])
  assert.deepEqual(fallbackChain({ model: 'solo', catalog: [] }), ['solo'])
})

test('the picker label carries the verdict and the structured flag', () => {
  const quota = { 'zaicoding_glm-5.3': { at: 1_000 } }
  const rows = annotateCatalog(
    [{ id: 'zai_auto', name: 'Auto' }, { id: 'zaicoding_glm-5.3', name: 'GLM-5.3' }],
    { quota, now: 1_100 },
  )
  assert.equal(rows[0].name, 'Auto')
  assert.equal(rows[0].quotaExhausted, false)
  assert.equal(rows[1].name, 'GLM-5.3 · 额度已用完')
  assert.equal(rows[1].quotaExhausted, true)
  // The id must not change: it is what a selection resolves to.
  assert.equal(rows[1].id, 'zaicoding_glm-5.3')
})

test('annotation never mangles rows it cannot understand', () => {
  const rows = annotateCatalog([null, { id: 'x' }, 'nope'], { quota: {} })
  assert.equal(rows[0], null)
  // No name on the row: the id stands in, which is what the picker shows.
  assert.equal(rows[1].name, 'x')
  assert.equal(rows[1].quotaExhausted, false)
  assert.deepEqual(annotateCatalog(undefined), [])
})
