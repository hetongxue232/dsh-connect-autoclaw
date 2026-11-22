// The catalog hot-refresh pieces: the announce sequence and the route body.
// No network, no Keychain — `index.js` statically imports the pi-ai stack, so
// these two live in `src/catalog.js` and `index.js` re-uses them there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalogAnnouncer, catalogResponseBody } from '../src/catalog.js'

test('the announcer runs refresh → report → invalidate → replace, in order', async () => {
  const calls = []
  const rows = [{ id: 'a' }, { id: 'b' }]
  const announce = createCatalogAnnouncer({
    refresh: async () => { calls.push('refresh'); return rows },
    report: (size, live) => { calls.push(`report:${size}:${live}`) },
    invalidate: () => { calls.push('invalidate') },
    replace: () => { calls.push('replace') },
  })
  const out = await announce()
  assert.equal(out, rows)
  assert.deepEqual(calls, ['refresh', 'report:2:true', 'invalidate', 'replace'])
})

test('a failed announce is a warning, not an error: the rows are already committed', async () => {
  const warnings = []
  const rows = [{ id: 'a' }]
  const invalidateCalls = []
  const announce = createCatalogAnnouncer({
    refresh: async () => rows,
    report: () => {},
    invalidate: () => { invalidateCalls.push(1) },
    replace: () => { throw new Error('boom') },
    logger: { warn: (message) => warnings.push(message) },
  })
  const out = await announce()
  assert.equal(out, rows)
  assert.equal(invalidateCalls.length, 1)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].startsWith('dsh-connect-autoclaw: catalog refresh announce failed:'))
  assert.ok(warnings[0].includes('boom'))
})

test('a non-array refresh result reports empty and not live', async () => {
  const seen = []
  const announce = createCatalogAnnouncer({
    refresh: async () => undefined,
    report: (size, live) => seen.push([size, live]),
    invalidate: () => {},
  })
  await announce()
  assert.deepEqual(seen, [[0, false]])
})

test('the route body carries the catalog and diagnostics verbatim', () => {
  const state = { catalogUpdatedAt: '2026-11-18T10:00:00.000Z', catalogSize: 2, catalogLive: true }
  const body = catalogResponseBody({ provider: 'atuoclaw', cache: [{ id: 'a' }, { id: 'b' }], state, refreshed: true })
  assert.deepEqual(body, {
    ok: true,
    provider: 'atuoclaw',
    refreshed: true,
    catalogUpdatedAt: '2026-11-18T10:00:00.000Z',
    catalogSize: 2,
    catalogLive: true,
    catalog: [{ id: 'a' }, { id: 'b' }],
  })
})

test('the route body degrades gracefully: no error field unless one exists', () => {
  const body = catalogResponseBody({ provider: 'atuoclaw', cache: [], state: {}, refreshed: false })
  assert.equal(body.ok, true)
  assert.equal(body.refreshed, false)
  assert.equal(body.catalogUpdatedAt, '')
  assert.equal(body.catalogSize, 0)
  assert.equal(body.catalogLive, false)
  assert.deepEqual(body.catalog, [])
  assert.equal('catalogError' in body, false)

  const withError = catalogResponseBody({ provider: 'atuoclaw', cache: [], state: { catalogError: 'gateway down' }, refreshed: false })
  assert.equal(withError.catalogError, 'gateway down')
})
