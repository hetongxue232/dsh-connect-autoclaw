// The probe's pure builders: tier resolution, filler sizing, gate compliance.
// No network, no Keychain. `index.js` statically imports the pi-ai stack, so
// these two functions live in `src/probe.js` and `index.js` re-exports them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeMessages, resolveProbeTokens, PROBE_TIERS } from '../src/probe.js'
import { REQUIRED_BANNER, translateRequest } from '../src/shim.js'

test('tiers resolve to the documented token counts, odd values fall to default', () => {
  assert.equal(resolveProbeTokens('small'), PROBE_TIERS.small)
  assert.equal(resolveProbeTokens('standard'), PROBE_TIERS.standard)
  assert.equal(resolveProbeTokens('large'), PROBE_TIERS.large)
  assert.equal(resolveProbeTokens('bogus'), PROBE_TIERS.standard)
  assert.equal(resolveProbeTokens(undefined), PROBE_TIERS.standard)
})

test('the filler sizes to the requested class (±10%)', () => {
  for (const tier of Object.keys(PROBE_TIERS)) {
    const messages = probeMessages('m', resolveProbeTokens(tier))
    const filler = messages[1].content
    const estimated = filler.length / 4.5
    const target = resolveProbeTokens(tier)
    assert.ok(estimated >= target * 0.95, `${tier}: ${estimated} >= ${target * 0.95}`)
    assert.ok(estimated <= target * 1.15, `${tier}: ${estimated} <= ${target * 1.15}`)
  }
})

test('the probe body survives the 406 gate unchanged', () => {
  const messages = probeMessages('zai_glm-5.3-flash', PROBE_TIERS.standard)
  const out = translateRequest({ model: 'zai_glm-5.3-flash', stream: false, messages })
  assert.ok(out.messages[0].content.startsWith(REQUIRED_BANNER))
  // translateRequest must not have doubled the banner: exactly one occurrence.
  assert.equal(out.messages[0].content.split(REQUIRED_BANNER).length - 1, 1)
  assert.equal(out.max_tokens, undefined)
  assert.equal(out.messages.length, 2)
})
