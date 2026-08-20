/**
 * Probabilistic Pivot Tournament (PPT): best-of-N selection from soft pairwise
 * rewards in O(N·k) comparisons instead of O(N²).
 *
 * 1. ring pass: a random Hamiltonian cycle (every candidate once in slot A and once in slot B)
 * 2. pivots: top-k by mean preference
 * 3. pivot round: every non-pivot vs every pivot, plus pivot-vs-pivot
 * 4. re-accumulate ring + pivot pairs, argmax mean preference (ties → lower index)
 */
/** Deterministic PRNG (mulberry32) so a seed reproduces the same ring. */
export declare function mulberry32(seed: number): () => number;
export type DirectedPair = readonly [a: number, b: number];
/** Random Hamiltonian cycle over n candidates as directed adjacent pairs. */
export declare function ringCycle(n: number, rng: () => number): DirectedPair[];
/** Soft win probability of A over B from two rewards in [0, 1]. */
export declare function bradleyTerry(rewardA: number, rewardB: number): number;
/** Per-candidate win mass and comparison count. */
export declare class Accumulator {
    readonly wins: number[];
    readonly counts: number[];
    constructor(n: number);
    add(a: number, b: number, rewardA: number, rewardB: number): void;
    mean(i: number): number;
    means(): number[];
    /** Argmax of mean preference; ties break toward the lower index. */
    best(): number;
}
/** Top-k candidates by mean preference (ties by lower index). */
export declare function selectPivots(accumulator: Accumulator, k: number): number[];
/** Every (non-pivot, pivot) pair plus the pivots among themselves. */
export declare function pivotRoundPairs(n: number, pivots: number[]): DirectedPair[];
export interface TournamentResult {
    best: number;
    ranking: number[];
    means: number[];
    comparisons: number;
    pivots: number[];
}
/**
 * Run the two-phase tournament. `scorePair(a, b)` returns directed rewards
 * (rewardA, rewardB); pairs inside a phase are scored concurrently.
 */
export declare function pivotTournament(n: number, pivotCount: number, seed: number, scorePair: (a: number, b: number) => Promise<readonly [number, number]>): Promise<TournamentResult>;
