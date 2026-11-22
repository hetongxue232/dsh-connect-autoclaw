/**
 * The catalog hot-refresh machinery, extracted from `index.js` so node:test can
 * exercise it (index.js statically imports the pi-ai stack and cannot load
 * under a plain runtime).
 *
 * Two pieces:
 *
 * - `createCatalogAnnouncer(deps)` — the sequence the host runs whenever the
 *   model catalog changes: re-read the source of truth, update the
 *   diagnostics state, drop the adapter's memoized view, and re-announce the
 *   route so `llm/adapters-updated` fires and the model picker re-reads the
 *   list. An announce failure is a warning, not an error: the fresh rows are
 *   already committed by the time it runs.
 * - `catalogResponseBody(deps)` — the exact JSON the loopback route answers,
 *   shared by the read path and the refresh path so both can never drift.
 */

/**
 * @param {() => Promise<unknown[]>} deps.refresh  re-reads the source of truth; the
 *   returned rows must already be committed where the adapter reads them
 * @param {(size: number, live: boolean) => void} deps.report  updates the
 *   diagnostics state (catalogSize / catalogLive / catalogUpdatedAt)
 * @param {() => void} deps.invalidate  drops the adapter's memoized catalog view
 * @param {() => void} [deps.replace]  re-announces the registration
 * @param {{warn?: (message: string) => void}} [deps.logger]
 * @returns {() => Promise<unknown[]>} the announcer; resolves with the fresh rows
 */
export function createCatalogAnnouncer({ refresh, report, invalidate, replace, logger }) {
  return async function announceFreshCatalog() {
    const rows = await refresh()
    report(Array.isArray(rows) ? rows.length : 0, Array.isArray(rows) && rows.length > 0)
    invalidate()
    try {
      replace?.()
    } catch (error) {
      logger?.warn?.(`dsh-connect-autoclaw: catalog refresh announce failed: ${String(error?.message ?? error)}`)
    }
    return rows
  }
}

/**
 * The route's response body. `refreshed` distinguishes the plain read from a
 * `?refresh=1` call so the settings card can tell the two apart.
 *
 * @param {{provider: string, cache: unknown[], state: Record<string, unknown>, refreshed: boolean}} deps
 */
export function catalogResponseBody({ provider, cache, state, refreshed }) {
  return {
    ok: true,
    provider,
    refreshed,
    catalogUpdatedAt: typeof state.catalogUpdatedAt === 'string' ? state.catalogUpdatedAt : '',
    catalogSize: typeof state.catalogSize === 'number' ? state.catalogSize : cache.length,
    catalogLive: state.catalogLive === true,
    catalog: cache,
    ...(typeof state.catalogError === 'string' && state.catalogError !== '' ? { catalogError: state.catalogError } : {}),
  }
}
