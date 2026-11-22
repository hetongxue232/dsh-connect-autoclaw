// Per-model health: 429/5xx demotion with consecutive counting and exponential
// backoff. Pure functions, injected clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_MAX_COOLDOWN_MS,
  demotedModels,
  isModelDemoted,
  noteModelOutcome,
  pruneModelHealth,
} from '../src/model-health.js'

const OPTS = { threshold: 2, cooldownMs: 1_000, maxCooldownMs: 8_000 }

test('a single 429 does not demote — one hiccup is not an outage', () => {
  const store = {}
  const v = noteModelOutcome(store, 'm', { kind: 'rate', at: 10_000 }, OPTS)
  assert.equal(v.demoted, false)
  assert.equal(v.failures, 1)
  assert.equal(isModelDemoted(store, 'm', 10_000), false)
})

test('the threshold-th consecutive failure demotes for one cooldown', () => {
  const store = {}
  noteModelOutcome(store, 'm', { kind: 'rate', at: 10_000 }, OPTS)
  const v = noteModelOutcome(store, 'm', { kind: 'rate', at: 10_500 }, OPTS)
  assert.equal(v.demoted, true)
  assert.equal(v.until, 11_500, 'at + 1x cooldown')
  assert.equal(isModelDemoted(store, 'm', 11_000), true)
  assert.equal(isModelDemoted(store, 'm', 11_500), false, 'expires exactly at `until`')
})

test('further failures double the window, capped', () => {
  const store = {}
  const at = (t) => noteModelOutcome(store, 'm', { kind: 'server', at: t }, OPTS)
  assert.equal(at(0).demoted, false, 'strike 1 of 2')
  assert.equal(at(0).until, 1_000, 'strike 2 trips it at 1x')
  assert.equal(at(0).until, 2_000, 'strike 3 → 2x')
  assert.equal(at(0).until, 4_000, 'strike 4 → 4x')
  assert.equal(at(0).until, 8_000, 'strike 5 → 8x')
  assert.equal(at(0).until, 8_000, 'capped at maxCooldownMs')
})

test('a success clears the record, including the streak', () => {
  const store = {}
  noteModelOutcome(store, 'm', { kind: 'rate', at: 0 }, OPTS)
  noteModelOutcome(store, 'm', { kind: 'rate', at: 0 }, OPTS)
  assert.equal(isModelDemoted(store, 'm', 0), true)
  noteModelOutcome(store, 'm', { kind: 'ok', at: 500 }, OPTS)
  assert.equal(isModelDemoted(store, 'm', 500), false)
  assert.equal(store.m, undefined, 'the streak restarts from zero')
})

test('a request-class failure is ignored, not counted — a client bug must not demote', () => {
  const store = {}
  for (let i = 0; i < 10; i += 1) {
    const v = noteModelOutcome(store, 'm', { kind: 'request', at: 0 }, OPTS)
    assert.equal(v.demoted, false)
  }
  assert.equal(isModelDemoted(store, 'm', 0), false)
  assert.equal(store.m?.failures ?? 0, 0, 'nothing counted')
})

test('credential failures are the account\'s problem, not the model\'s', () => {
  const store = {}
  for (let i = 0; i < 5; i += 1) noteModelOutcome(store, 'm', { kind: 'credential', at: 0 }, OPTS)
  assert.equal(isModelDemoted(store, 'm', 0), false)
})

test('two models are tracked independently', () => {
  const store = {}
  noteModelOutcome(store, 'a', { kind: 'rate', at: 0 }, OPTS)
  noteModelOutcome(store, 'a', { kind: 'rate', at: 0 }, OPTS)
  noteModelOutcome(store, 'b', { kind: 'rate', at: 0 }, OPTS)
  assert.equal(isModelDemoted(store, 'a', 0), true)
  assert.equal(isModelDemoted(store, 'b', 0), false, 'b is still on its first strike')
})

test('demotedModels lists only the live ones', () => {
  const store = {}
  noteModelOutcome(store, 'a', { kind: 'rate', at: 0 }, OPTS)
  noteModelOutcome(store, 'a', { kind: 'rate', at: 0 }, OPTS) // a: until 1000
  noteModelOutcome(store, 'b', { kind: 'server', at: 0 }, OPTS)
  noteModelOutcome(store, 'b', { kind: 'server', at: 0 }, OPTS) // b: until 1000
  assert.deepEqual(demotedModels(store, 500).sort(), ['a', 'b'])
  assert.deepEqual(demotedModels(store, 1_000), [], 'both expired')
})

test('prune keeps a live cooldown and a live streak, drops the dead rest', () => {
  const store = {
    cooling: { failures: 3, until: 5_000, at: 0, kind: 'rate' },
    streak: { failures: 1, until: 0, at: 0, kind: 'rate' },
    dead: { failures: 0, until: 0, at: 0, kind: 'rate' },
    junk: null,
  }
  pruneModelHealth(store, 1_000)
  assert.ok(store.cooling !== undefined, 'still cooling')
  assert.ok(store.streak !== undefined, 'a streak outlives its window so backoff resumes')
  assert.equal('dead' in store, false)
  assert.equal('junk' in store, false)
})

test('an empty model id is not recorded', () => {
  const store = {}
  assert.equal(noteModelOutcome(store, '', { kind: 'rate' }, OPTS).demoted, false)
  assert.deepEqual(store, {})
})

test('the defaults are the documented ones', () => {
  assert.equal(DEFAULT_FAILURE_THRESHOLD, 2)
  assert.equal(DEFAULT_COOLDOWN_MS, 60_000)
  assert.equal(DEFAULT_MAX_COOLDOWN_MS, 15 * 60 * 1000)
})

test('a nonsense threshold falls back to the default instead of demoting on strike one', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, undefined]) {
    const store = {}
    const opts = { threshold: bad, cooldownMs: 1_000 }
    const first = noteModelOutcome(store, 'm', { kind: 'rate', at: 0 }, opts)
    assert.equal(first.demoted, false, `threshold ${String(bad)}: strike 1 must not demote`)
    const second = noteModelOutcome(store, 'm', { kind: 'rate', at: 0 }, opts)
    assert.equal(second.demoted, true, `threshold ${String(bad)}: strike ${DEFAULT_FAILURE_THRESHOLD} does`)
  }
})
