/**
 * Score extraction: expectation over the letter-token logprob distribution at
 * the position right after a `<tag>` marker, with a plain-text fallback.
 */
/** One generated token with its top-k alternatives (OpenAI `logprobs.content[i]` shape). */
export interface TokenLogprob {
    token: string;
    logprob: number;
    topLogprobs: {
        token: string;
        logprob: number;
    }[];
}
export type ScoreSource = 'logprobs' | 'text' | 'fallback';
export interface ScoreExtraction {
    /** Reward in [0, 1]. */
    score: number;
    /** How the reward was obtained. */
    source: ScoreSource;
    /** Literal letter found in the text (fallback parse), when any. */
    letter?: string;
    /** Renormalized letter distribution (probability mass per upper-case letter), logprobs source only. */
    distribution?: Record<string, number>;
}
/** Reward used when nothing parseable was produced (the reference implementation's neutral 0.5). */
export declare const NEUTRAL_SCORE = 0.5;
/**
 * Expected normalized score from the logprob distribution at the tag position.
 * Falls back to the literal `<tag> X </tag>` letter, then to {@link NEUTRAL_SCORE}.
 * @param text - full completion text.
 * @param tokens - token logprobs aligned with `text` (may be undefined).
 * @param tag - tag name without angle brackets, e.g. `score_A`.
 * @param valueOf - letter → scale value (pairwise or progress orientation).
 */
export declare function extractScore(text: string, tokens: TokenLogprob[] | undefined, tag: string, valueOf: (letter: string) => number | undefined): ScoreExtraction;
/** Last `<tag> X </tag>` letter in the text, case-insensitive. */
export declare function parseLiteralLetter(text: string, tag: string): string | undefined;
/** The analysis portion of a verdict: everything before the first score tag. */
export declare function analysisBefore(text: string, tag: string): string;
