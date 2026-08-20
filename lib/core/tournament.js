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
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Random Hamiltonian cycle over n candidates as directed adjacent pairs. */
export function ringCycle(n, rng) {
    if (n < 2)
        return [];
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }
    if (n === 2)
        return [[order[0], order[1]], [order[1], order[0]]];
    return order.map((a, i) => [a, order[(i + 1) % n]]);
}
/** Soft win probability of A over B from two rewards in [0, 1]. */
export function bradleyTerry(rewardA, rewardB) {
    return 1 / (1 + Math.exp(-(rewardA - rewardB)));
}
/** Per-candidate win mass and comparison count. */
export class Accumulator {
    wins;
    counts;
    constructor(n) {
        this.wins = new Array(n).fill(0);
        this.counts = new Array(n).fill(0);
    }
    add(a, b, rewardA, rewardB) {
        const p = bradleyTerry(rewardA, rewardB);
        this.wins[a] += p;
        this.counts[a] += 1;
        this.wins[b] += 1 - p;
        this.counts[b] += 1;
    }
    mean(i) {
        const count = this.counts[i];
        return count === 0 ? 0 : this.wins[i] / count;
    }
    means() {
        return this.wins.map((_, i) => this.mean(i));
    }
    /** Argmax of mean preference; ties break toward the lower index. */
    best() {
        let best = 0;
        for (let i = 1; i < this.wins.length; i++)
            if (this.mean(i) > this.mean(best))
                best = i;
        return best;
    }
}
/** Top-k candidates by mean preference (ties by lower index). */
export function selectPivots(accumulator, k) {
    const indexes = accumulator.wins.map((_, i) => i);
    indexes.sort((x, y) => {
        const diff = accumulator.mean(y) - accumulator.mean(x);
        return diff !== 0 ? diff : x - y;
    });
    return indexes.slice(0, Math.max(0, Math.min(k, indexes.length))).sort((x, y) => x - y);
}
/** Every (non-pivot, pivot) pair plus the pivots among themselves. */
export function pivotRoundPairs(n, pivots) {
    const pivotSet = new Set(pivots);
    const pairs = [];
    for (let i = 0; i < n; i++) {
        if (pivotSet.has(i))
            continue;
        for (const pivot of pivots)
            pairs.push([i, pivot]);
    }
    for (let x = 0; x < pivots.length; x++) {
        for (let y = x + 1; y < pivots.length; y++)
            pairs.push([pivots[x], pivots[y]]);
    }
    return pairs;
}
/**
 * Run the two-phase tournament. `scorePair(a, b)` returns directed rewards
 * (rewardA, rewardB); pairs inside a phase are scored concurrently.
 */
export async function pivotTournament(n, pivotCount, seed, scorePair) {
    if (n === 0)
        throw new Error('pivotTournament: at least one candidate is required');
    if (n === 1)
        return { best: 0, ranking: [0], means: [1], comparisons: 0, pivots: [0] };
    const rng = mulberry32(seed);
    const ring = ringCycle(n, rng);
    const ringScores = await Promise.all(ring.map(([a, b]) => scorePair(a, b)));
    const phaseA = new Accumulator(n);
    ring.forEach(([a, b], i) => phaseA.add(a, b, ringScores[i][0], ringScores[i][1]));
    const pivots = selectPivots(phaseA, Math.max(1, pivotCount));
    const pivotPairs = pivotRoundPairs(n, pivots);
    const pivotScores = await Promise.all(pivotPairs.map(([a, b]) => scorePair(a, b)));
    const phaseB = new Accumulator(n);
    ring.forEach(([a, b], i) => phaseB.add(a, b, ringScores[i][0], ringScores[i][1]));
    pivotPairs.forEach(([a, b], i) => phaseB.add(a, b, pivotScores[i][0], pivotScores[i][1]));
    const means = phaseB.means();
    const ranking = means.map((_, i) => i).sort((x, y) => (means[y] - means[x]) || (x - y));
    return { best: phaseB.best(), ranking, means, comparisons: ring.length + pivotPairs.length, pivots };
}
//# sourceMappingURL=tournament.js.map