/**
 * The 20-point letter scale shared by every verifier prompt.
 *
 * Letters (A..T) instead of digits so that one token carries the whole score
 * distribution: the reward is the expectation over the token's logprobs, not
 * the sampled letter (llm-as-a-verifier, arXiv 2607.05391).
 *
 * Two orientations exist, exactly as in the reference implementation:
 *  - pairwise scale: A = best (φ=20) … T = worst (φ=1)
 *  - progress scale: A = certainly NO (φ=1) … T = certainly YES (φ=20)
 */

export const GRANULARITY = 20

export const LETTERS = 'ABCDEFGHIJKLMNOPQRST'

/** A..T → 20..1 (pairwise orientation: A is the best outcome). */
export function pairwiseValue(letter: string): number | undefined {
  const index = LETTERS.indexOf(letter.toUpperCase())
  return index === -1 ? undefined : GRANULARITY - index
}

/** A..T → 1..20 (progress orientation: T is the best outcome). */
export function progressValue(letter: string): number | undefined {
  const index = LETTERS.indexOf(letter.toUpperCase())
  return index === -1 ? undefined : index + 1
}

/** Min-max normalize an expected scale value into [0, 1]. */
export function normalizeExpected(expected: number): number {
  const value = (expected - 1) / (GRANULARITY - 1)
  return Math.min(1, Math.max(0, value))
}

/** Verbatim pairwise rating scale (A = best). */
export const PAIRWISE_SCALE_DESCRIPTION
  = 'Rate how likely the agent correctly solved the task on a '
    + '20-point scale using letters A through T:\n'
    + '  A = clearly and completely succeeded with verified output (best)\n'
    + '  B-D = succeeded with only minor issues\n'
    + '  E-G = above average, mostly correct with some issues\n'
    + '  H-J = uncertain, leans toward success\n'
    + '  K-M = uncertain, leans toward failure\n'
    + '  N-P = below average, significant issues remain\n'
    + '  Q-S = failed with some partial progress\n'
    + '  T = clearly and completely failed (worst)'

/** Verbatim progress scale (T = best), used to judge one trajectory on its own. */
export const PROGRESS_SCALE_DESCRIPTION
  = 'Use the 20-letter A..T scale:\n'
    + '  A = certainly NO: nothing useful done yet, or the agent is going down a clearly wrong path.\n'
    + '  B-G = leans NO: partial work exists but key pieces are missing or broken.\n'
    + '  H-M = uncertain: a plausible solution is taking shape, but no convincing verification yet.\n'
    + '  N-S = leans YES: the right artifacts appear to be in place and partial verification has worked, with minor concerns.\n'
    + '  T = essentially certain YES: the agent has run the relevant verification and the observed output literally matches what the task calls for, with no outstanding errors.'
