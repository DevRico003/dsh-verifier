/**
 * Prompt builders and built-in criteria sets.
 *
 * Prefix-cache discipline (the reference implementation's 3.4× cost win):
 * everything invariant across criteria (task, trajectories, scale) comes
 * FIRST; only the criterion varies at the tail. Keep that ordering.
 */
export interface Criterion {
    id: string;
    name: string;
    description: string;
}
export interface CriteriaSet {
    /** Injected into every comparison; the anti-sycophancy instruction. */
    groundTruthNote: string;
    criteria: Criterion[];
}
export declare const CRITERIA_SETS: Record<string, CriteriaSet>;
export declare const CRITERIA_SET_NAMES: string[];
/** Resolve a named set or a custom list; throws on an unknown name. */
export declare function resolveCriteria(name: string): CriteriaSet;
export declare const PAIRWISE_TAG_A = "score_A";
export declare const PAIRWISE_TAG_B = "score_B";
export declare const ASSESS_TAG = "score";
/** Pairwise comparison prompt, verbatim structure of the reference `build_prompt`. */
export declare function buildPairwisePrompt(problem: string, traceA: string, traceB: string, criterion: Criterion, groundTruthNote: string): string;
/**
 * Single-trajectory assessment prompt: the reference progress prompt reduced
 * to one checkpoint (the final state), scored on one criterion.
 */
export declare function buildAssessmentPrompt(problem: string, trajectory: string, criterion: Criterion, groundTruthNote: string): string;
