/**
 * Verifier algorithms: directed pairwise reward, best-of-N selection via the
 * pivot tournament, and single-trajectory assessment. Pure of harness types;
 * the plugin wires a backend in.
 */
import type { VerifierBackend } from './backend.js';
import { type Criterion } from './prompts.js';
import { type ScoreSource } from './scoring.js';
export interface VerifierOptions {
    backend: VerifierBackend;
    criteria: Criterion[];
    groundTruthNote: string;
    /** K: repeated evaluations per criterion (odd repeats swap the A/B slots). */
    evaluations: number;
    /** Concurrency cap for backend calls. */
    concurrency: number;
    maxTokens: number;
    temperature: number;
    topLogprobs: number;
    signal?: AbortSignal;
    /** Swallow backend failures as neutral 0.5 (`tie`) or rethrow (`raise`). */
    onError: 'tie' | 'raise';
    /** Re-ask the backend when a completion carries no parseable score or failed (default 1). */
    retriesOnFallback?: number;
    /** Finish the first call per shared prompt prefix before fanning out the rest (prefix-cache warm-up). */
    warmPrefix?: boolean;
    /** Per-call reasoning effort; unset = backend default. */
    reasoningEffort?: string;
    /** Optional sink for per-call diagnostics. */
    onCall?: (info: CallInfo) => void;
}
export interface CallInfo {
    kind: 'pairwise' | 'assess';
    criterion: string;
    repeat: number;
    durationMs: number;
    source: ScoreSource | 'error';
    cachedTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    error?: string;
    /** For a `fallback` reading: finish reason, reasoning size and the tail of the reply, so an unparseable verdict can be diagnosed from the log. */
    detail?: string;
}
/** One line for a thrown value: an Error's message, a plain object (an abort reason, a JSON error body) serialized, anything else stringified. */
export declare function describeError(error: unknown): string;
export interface PairwiseResult {
    rewardA: number;
    rewardB: number;
    /** Per criterion × repeat rewards in candidate order. */
    samples: {
        criterion: string;
        repeat: number;
        rewardA: number;
        rewardB: number;
        source: ScoreSource | 'error';
    }[];
}
export interface SelectResult {
    index: number;
    best: string;
    scores: number[];
    ranking: number[];
    comparisons: number;
    pivots: number[];
}
export interface AssessResult {
    /** Mean reward over the scored criteria, in [0, 1]; 0.5 when nothing could be scored. */
    score: number;
    perCriterion: {
        id: string;
        name: string;
        score: number;
        analysis: string;
        source: ScoreSource | 'error';
        scored: boolean;
    }[];
    /** How many criteria produced a real verdict; 0 means the result is not a judgement. */
    scoredCriteria: number;
}
/** One directed pairwise reward (R_a, R_b) in [0, 1]. */
export declare function compare(problem: string, a: string, b: string, options: VerifierOptions): Promise<PairwiseResult>;
/** Best-of-N selection with the probabilistic pivot tournament. */
export declare function select(problem: string, candidates: string[], options: VerifierOptions & {
    pivots: number;
    seed: number;
}): Promise<SelectResult>;
/**
 * Single-trajectory assessment: mean progress-scale reward over criteria × repeats.
 * A completion without a parseable score (`fallback`) or a failed call is retried
 * up to `retriesOnFallback` times; what still has no verdict is excluded from the
 * means instead of counting as a neutral 0.5, and reported as unscored.
 */
export declare function assess(problem: string, trajectory: string, options: VerifierOptions): Promise<AssessResult>;
