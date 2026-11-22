/**
 * Host-header and Origin guards for the plugin's loopback routes.
 *
 * Kept in its own module so a unit test can import the pure guard without
 * pulling in `index.js` (whose provider half statically imports the pi-ai
 * stack that only the DSH application's loader can resolve).
 *
 * @module dsh-connect-autoclaw/loopback
 */

import { isIP } from 'node:net'

/** Loopback hostnames that name this machine without comparing a bind address. */
export const LOOPBACK_HOSTS = new Set(['localhost', '[::1]'])

/** Whether a Host header names this machine. A DNS-rebinding page cannot forge it. */
export function hostIsLoopback(host) {
  if (typeof host !== 'string' || host === '') return false
  const lowered = host.toLowerCase()
  // Strip the port FIRST: a Host header carries one, and `localhost:3000` is
  // still this machine while `localhost.evil.example` is not.
  const bare = lowered.startsWith('[') ? lowered.slice(1, lowered.indexOf(']')) : lowered.split(':')[0]
  if (LOOPBACK_HOSTS.has(bare)) return true
  if (isIP(bare) === 4) return bare.startsWith('127.')
  if (isIP(bare) === 6) return bare === '::1' || bare === '0:0:0:0:0:0:0:1'
  return false
}

/** Whether an Origin header is this machine's. No Origin at all is a non-browser caller and passes. */
export function originIsLoopback(origin) {
  if (origin === undefined || origin === '') return true
  try {
    const { hostname } = new URL(origin)
    return hostIsLoopback(hostname === '::1' ? '[::1]' : hostname)
  } catch {
    return false
  }
}
