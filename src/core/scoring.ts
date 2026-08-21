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
 * Locate the token that carries the letter following the LAST `<tag>` in the
 * generated token stream. Token-driven, not text-driven: with thinking on,
 * vLLM puts the reasoning tokens into `logprobs.content` as well, so token
 * offsets do not line up with `message.content`. Tolerates tokenizers that
 * fuse `>` with the letter (`>A`), split the tag (`<`, `score`, `>`), or emit
 * whitespace-only tokens between the tag and the letter.
 *
 * @returns the token index plus whether the token still starts with the
 * tag's closing `>` (so alternatives are stripped the same way).
 */
function locateLetterToken(tokens: TokenLogprob[], tag: string): { index: number; stripClose: boolean } | undefined {
  const open = `<${tag}>`
  const openNoClose = `<${tag}`
  // Every position where the accumulated token text ends with the tag. With
  // thinking on, the reasoning often quotes the format ("<c1>LETTER</c1>"), so
  // the LAST occurrence is not always the verdict: walk back from the end and
  // take the first occurrence that is followed by a scale letter.
  const candidates: { index: number; fusedClose: boolean }[] = []
  let accumulated = ''
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.token
    accumulated += token
    if (token.trim() === '') continue
    const trimmed = accumulated.trimEnd()
    if (trimmed.endsWith(open)) candidates.push({ index: i, fusedClose: false })
    else if (trimmed.endsWith(openNoClose)) candidates.push({ index: i, fusedClose: true })
  }
  for (let c = candidates.length - 1; c >= 0; c--) {
    let { fusedClose } = candidates[c]!
    let j = candidates[c]!.index + 1
    while (j < tokens.length && tokens[j]!.token.trim() === '') j++
    if (j >= tokens.length) continue
    if (fusedClose && tokens[j]!.token.trim() === '>') {
      j++
      while (j < tokens.length && tokens[j]!.token.trim() === '') j++
      if (j >= tokens.length) continue
      fusedClose = false
    }
    let body = tokens[j]!.token.trimStart()
    if (body.startsWith('>')) body = body.slice(1)
    if (asLetter(body) !== undefined) return { index: j, stripClose: fusedClose }
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
    const located = locateLetterToken(tokens, tag)
    if (located !== undefined) {
      const token = tokens[located.index]!
      const mass: Record<string, number> = {}
      const consider = (candidate: string, logprob: number): void => {
        // `>A` (fused closing bracket) and `A` both mean the letter A.
        let body = candidate.trimStart()
        if (body.startsWith('>')) body = body.slice(1)
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
  const literal = parseLiteralLetter(text, tag) ?? parseBareLetter(text, tag)
  if (literal !== undefined) {
    const value = valueOf(literal)
    if (value !== undefined) return { score: normalizeExpected(value), source: 'text', letter: literal }
  }
  return { score: NEUTRAL_SCORE, source: 'fallback' }
}

/**
 * A reply that skipped the tags: a bare letter as the whole reply or its last
 * line (`S`), or `c1: S` / `Checkpoint 1: S` style (the reference's bare-line
 * fallback for progress scoring).
 */
export function parseBareLetter(text: string, tag: string): string | undefined {
  const lines = text.trim().split('\n').map(line => line.trim()).filter(line => line !== '')
  const last = lines.at(-1)
  if (last === undefined) return undefined
  const bare = /^\**([A-Ta-t])\**\.?$/.exec(last)
  if (bare !== null) return bare[1]!.toUpperCase()
  const tagged = new RegExp(`^(?:<?${tag}>?|checkpoint\\s*1|score)\\s*[:=]?\\s*\\**([A-Ta-t])\\**\\.?$`, 'i').exec(last)
  return tagged === null ? undefined : tagged[1]!.toUpperCase()
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
