/**
 * Score extraction: expectation over the letter-token logprob distribution at
 * the position right after a `<tag>` marker, with a plain-text fallback.
 */
import { LETTERS, normalizeExpected } from './scale.js';
/** Reward used when nothing parseable was produced (the reference implementation's neutral 0.5). */
export const NEUTRAL_SCORE = 0.5;
function asLetter(candidate) {
    const trimmed = candidate.trim();
    if (trimmed.length !== 1)
        return undefined;
    const upper = trimmed.toUpperCase();
    return LETTERS.includes(upper) ? upper : undefined;
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
function locateLetterToken(tokens, tag) {
    const open = `<${tag}>`;
    const openNoClose = `<${tag}`;
    let accumulated = '';
    let found = -1;
    let fusedClose = false;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].token;
        accumulated += token;
        // A whitespace-only token leaves the trimmed text unchanged and would match
        // the tag a second time, shadowing the distribution captured at the
        // previous position.
        if (token.trim() === '')
            continue;
        const trimmed = accumulated.trimEnd();
        if (trimmed.endsWith(open)) {
            found = i;
            fusedClose = false;
        }
        else if (trimmed.endsWith(openNoClose)) {
            found = i;
            fusedClose = true;
        }
    }
    if (found === -1)
        return undefined;
    let j = found + 1;
    while (j < tokens.length && tokens[j].token.trim() === '')
        j++;
    if (j >= tokens.length)
        return undefined;
    if (fusedClose && tokens[j].token.trim() === '>') {
        // The closing bracket came as its own token; the letter follows.
        j++;
        while (j < tokens.length && tokens[j].token.trim() === '')
            j++;
        if (j >= tokens.length)
            return undefined;
        fusedClose = false;
    }
    return { index: j, stripClose: fusedClose };
}
/**
 * Expected normalized score from the logprob distribution at the tag position.
 * Falls back to the literal `<tag> X </tag>` letter, then to {@link NEUTRAL_SCORE}.
 * @param text - full completion text.
 * @param tokens - token logprobs aligned with `text` (may be undefined).
 * @param tag - tag name without angle brackets, e.g. `score_A`.
 * @param valueOf - letter → scale value (pairwise or progress orientation).
 */
export function extractScore(text, tokens, tag, valueOf) {
    if (tokens !== undefined && tokens.length > 0) {
        const located = locateLetterToken(tokens, tag);
        if (located !== undefined) {
            const token = tokens[located.index];
            const mass = {};
            const consider = (candidate, logprob) => {
                // `>A` (fused closing bracket) and `A` both mean the letter A.
                let body = candidate.trimStart();
                if (body.startsWith('>'))
                    body = body.slice(1);
                const letter = asLetter(body);
                if (letter === undefined)
                    return;
                const p = Math.exp(logprob);
                mass[letter] = Math.max(mass[letter] ?? 0, p);
            };
            for (const alternative of token.topLogprobs)
                consider(alternative.token, alternative.logprob);
            consider(token.token, token.logprob);
            let total = 0;
            let weighted = 0;
            for (const [letter, p] of Object.entries(mass)) {
                const value = valueOf(letter);
                if (value === undefined)
                    continue;
                total += p;
                weighted += p * value;
            }
            if (total > 0) {
                const distribution = {};
                for (const [letter, p] of Object.entries(mass))
                    distribution[letter] = p / total;
                return { score: normalizeExpected(weighted / total), source: 'logprobs', distribution };
            }
        }
    }
    const literal = parseLiteralLetter(text, tag);
    if (literal !== undefined) {
        const value = valueOf(literal);
        if (value !== undefined)
            return { score: normalizeExpected(value), source: 'text', letter: literal };
    }
    return { score: NEUTRAL_SCORE, source: 'fallback' };
}
/** Last `<tag> X </tag>` letter in the text, case-insensitive. */
export function parseLiteralLetter(text, tag) {
    const pattern = new RegExp(`<${tag}>\\s*([A-Ta-t])\\s*</${tag}>`, 'gi');
    let found;
    for (const match of text.matchAll(pattern))
        found = match[1].toUpperCase();
    return found;
}
/** The analysis portion of a verdict: everything before the first score tag. */
export function analysisBefore(text, tag) {
    const at = text.lastIndexOf(`<${tag}>`);
    return (at === -1 ? text : text.slice(0, at)).trim();
}
//# sourceMappingURL=scoring.js.map