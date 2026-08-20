/**
 * Score extraction: expectation over the letter-token logprob distribution at
 * the position right after a `<tag>` marker, with a plain-text fallback.
 */

import { LETTERS, normalizeExpected } from './scale.js'

/** One generated token with its top-k alternatives (OpenAI `logprobs.content[i]` shape). */
export interface TokenLogprob {
  token: string
  logprob: number
  topLogprobs: { token: string; logprob: number }[]
}

export type ScoreSource = 'logprobs' | 'text' | 'fallback'

export interface ScoreExtraction {
  /** Reward in [0, 1]. */
  score: number
  /** How the reward was obtained. */
  source: ScoreSource
  /** Literal letter found in the text (fallback parse), when any. */
  letter?: string
  /** Renormalized letter distribution (probability mass per upper-case letter), logprobs source only. */
  distribution?: Record<string, number>
}

/** Reward used when nothing parseable was produced (the reference implementation's neutral 0.5). */
export const NEUTRAL_SCORE = 0.5

function asLetter(candidate: string): string | undefined {
  const trimmed = candidate.trim()
  if (trimmed.length !== 1) return undefined
  const upper = trimmed.toUpperCase()
  return LETTERS.includes(upper) ? upper : undefined
}

/**
 * Locate the token that carries the letter following the LAST `<tag>` in
 * `text`, tolerating tokenizers that fuse `>` with the letter or emit
 * whitespace-only tokens between the tag and the letter.
 *
 * @returns the token index plus the non-letter prefix inside that token that
 * belongs to the tag/whitespace (so alternatives can be stripped the same way).
 */
function locateLetterToken(text: string, tokens: TokenLogprob[], tag: string): { index: number; prefix: string } | undefined {
  const open = `<${tag}>`
  const at = text.lastIndexOf(open)
  if (at === -1) return undefined
  const position = at + open.length
  let offset = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.token
    const start = offset
    const end = offset + token.length
    offset = end
    if (end <= position) continue
    // This token covers `position`; the part before it belongs to the tag.
    const prefix = token.slice(0, Math.max(0, position - start))
    const remainder = token.slice(prefix.length)
    if (remainder.trim() === '') {
      // Whitespace-only remainder (e.g. `>` or `> `): the letter is in a later token.
      // Skip following whitespace-only tokens.
      let j = i + 1
      while (j < tokens.length && tokens[j]!.token.trim() === '') j++
      return j < tokens.length ? { index: j, prefix: '' } : undefined
    }
    return { index: i, prefix }
  }
  return undefined
}

/**
 * Expected normalized score from the logprob distribution at the tag position.
 * Falls back to the literal `<tag> X </tag>` letter, then to {@link NEUTRAL_SCORE}.
 * @param text - full completion text.
 * @param tokens - token logprobs aligned with `text` (may be undefined).
 * @param tag - tag name without angle brackets, e.g. `score_A`.
 * @param valueOf - letter → scale value (pairwise or progress orientation).
 */
export function extractScore(
  text: string,
  tokens: TokenLogprob[] | undefined,
  tag: string,
  valueOf: (letter: string) => number | undefined,
): ScoreExtraction {
  if (tokens !== undefined && tokens.length > 0) {
    const located = locateLetterToken(text, tokens, tag)
    if (located !== undefined) {
      const token = tokens[located.index]!
      const mass: Record<string, number> = {}
      const consider = (candidate: string, logprob: number): void => {
        let body = candidate
        if (located.prefix !== '' && body.startsWith(located.prefix)) body = body.slice(located.prefix.length)
        else if (located.prefix !== '') {
          // Alternative without the fused prefix (e.g. `A` vs `>A`): accept when it is a bare letter.
          body = candidate
        }
        const letter = asLetter(body)
        if (letter === undefined) return
        const p = Math.exp(logprob)
        mass[letter] = Math.max(mass[letter] ?? 0, p)
      }
      for (const alternative of token.topLogprobs) consider(alternative.token, alternative.logprob)
      consider(token.token, token.logprob)
      let total = 0
      let weighted = 0
      for (const [letter, p] of Object.entries(mass)) {
        const value = valueOf(letter)
        if (value === undefined) continue
        total += p
        weighted += p * value
      }
      if (total > 0) {
        const distribution: Record<string, number> = {}
        for (const [letter, p] of Object.entries(mass)) distribution[letter] = p / total
        return { score: normalizeExpected(weighted / total), source: 'logprobs', distribution }
      }
    }
  }
  const literal = parseLiteralLetter(text, tag)
  if (literal !== undefined) {
    const value = valueOf(literal)
    if (value !== undefined) return { score: normalizeExpected(value), source: 'text', letter: literal }
  }
  return { score: NEUTRAL_SCORE, source: 'fallback' }
}

/** Last `<tag> X </tag>` letter in the text, case-insensitive. */
export function parseLiteralLetter(text: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}>\\s*([A-Ta-t])\\s*</${tag}>`, 'gi')
  let found: string | undefined
  for (const match of text.matchAll(pattern)) found = match[1]!.toUpperCase()
  return found
}

/** The analysis portion of a verdict: everything before the first score tag. */
export function analysisBefore(text: string, tag: string): string {
  const at = text.lastIndexOf(`<${tag}>`)
  return (at === -1 ? text : text.slice(0, at)).trim()
}
