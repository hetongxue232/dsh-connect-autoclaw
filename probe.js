/**
 * The connectivity probe's pure builders.
 *
 * Sized after `dsh-connect-workbuddy`'s `src/probe.ts`: a probe that sends a
 * handful of tokens answers "usable" while every real request in a long
 * conversation is refused, because upstream throttles on REQUEST SIZE. The
 * filler is the sibling's own English line (~4.5 chars/token, measured), and
 * the tiers bracket it around the user's real conversation sizes.
 *
 * Kept free of the pi-ai imports so the unit test can load it directly.
 *
 * @module dsh-connect-autoclaw/probe
 */

import { REQUIRED_BANNER } from './shim.js'

/** The three sizes the card offers, in input tokens. */
export const PROBE_TIERS = Object.freeze({
  small: 10_000,
  standard: 28_000,
  large: 50_000,
})

export const PROBE_DEFAULT_TIER = 'standard'

/** Characters per token for the filler, measured by the sibling at ~4.5. */
export const PROBE_CHARS_PER_TOKEN = 4.5

/** Neutral filler; carries no user content, only volume. */
export const PROBE_FILLER_LINE = 'The quick brown fox jumps over the lazy dog. '

/** Resolve a requested tier to a token count; odd values fall to the default. */
export function resolveProbeTokens(tier) {
  return PROBE_TIERS[tier] ?? PROBE_TIERS[PROBE_DEFAULT_TIER]
}

/**
 * Build the probe messages: the gate's banner in system (translateRequest
 * keeps it and never doubles it), the filler as user volume, and a one-word
 * instruction so the paid output stays tiny — AutoClaw's gateway refuses
 * client `max_tokens`, so the output cap is a prompt constraint.
 */
export function probeMessages(model, tokens) {
  const targetChars = Math.ceil(tokens * PROBE_CHARS_PER_TOKEN)
  const filler = PROBE_FILLER_LINE.repeat(Math.ceil(targetChars / PROBE_FILLER_LINE.length))
  return [
    {
      role: 'system',
      content: `${REQUIRED_BANNER}\n\nYou are a connectivity check. Reply with a single word.`,
    },
    { role: 'user', content: `${filler}Reply with a single word.` },
  ]
}
