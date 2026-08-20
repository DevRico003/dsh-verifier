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
export declare const GRANULARITY = 20;
export declare const LETTERS = "ABCDEFGHIJKLMNOPQRST";
/** A..T → 20..1 (pairwise orientation: A is the best outcome). */
export declare function pairwiseValue(letter: string): number | undefined;
/** A..T → 1..20 (progress orientation: T is the best outcome). */
export declare function progressValue(letter: string): number | undefined;
/** Min-max normalize an expected scale value into [0, 1]. */
export declare function normalizeExpected(expected: number): number;
/** Verbatim pairwise rating scale (A = best). */
export declare const PAIRWISE_SCALE_DESCRIPTION: string;
/** Verbatim progress scale (T = best), used to judge one trajectory on its own. */
export declare const PROGRESS_SCALE_DESCRIPTION: string;
