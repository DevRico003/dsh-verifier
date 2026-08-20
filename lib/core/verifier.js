/**
 * Verifier algorithms: directed pairwise reward, best-of-N selection via the
 * pivot tournament, and single-trajectory assessment. Pure of harness types;
 * the plugin wires a backend in.
 */
import { ASSESS_TAG, buildAssessmentPrompt, buildPairwisePrompt, buildProgressPrompt, PAIRWISE_TAG_A, PAIRWISE_TAG_B, PROGRESS_TAG } from './prompts.js';
import { pairwiseValue, progressValue } from './scale.js';
import { analysisBefore, extractScore, NEUTRAL_SCORE } from './scoring.js';
import { pivotTournament } from './tournament.js';
/** Tiny semaphore so criteria × repeats × pairs fan out without flooding the server. */
function limiter(concurrency) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= concurrency)
            return;
        const run = queue.shift();
        if (run === undefined)
            return;
        active++;
        run();
    };
    return task => new Promise((resolve, reject) => {
        queue.push(() => {
            task().then(resolve, reject).finally(() => {
                active--;
                next();
            });
        });
        next();
    });
}
/**
 * Run `jobs` with the reference's warm-up wave: one job per distinct prefix
 * key first, then the rest, so a prefix-caching backend serves the shared
 * trajectory from cache instead of prefilling it once per call.
 */
async function runWarm(jobs, warm) {
    if (!warm || jobs.length <= 1)
        return Promise.all(jobs.map(job => job.run()));
    const results = new Array(jobs.length);
    const seen = new Set();
    const first = [];
    const rest = [];
    jobs.forEach((job, index) => {
        if (seen.has(job.key))
            rest.push(index);
        else {
            seen.add(job.key);
            first.push(index);
        }
    });
    await Promise.all(first.map(async (index) => { results[index] = await jobs[index].run(); }));
    await Promise.all(rest.map(async (index) => { results[index] = await jobs[index].run(); }));
    return results;
}
async function scoreDirectedPair(problem, a, b, options, run) {
    const jobs = [];
    for (const criterion of options.criteria) {
        for (let repeat = 0; repeat < options.evaluations; repeat++)
            jobs.push({ criterion, repeat });
    }
    const retries = options.retriesOnFallback ?? 1;
    const samples = await runWarm(jobs.map(({ criterion, repeat }) => ({ key: repeat % 2 === 1 ? 'ba' : 'ab', run: () => run(async () => {
            const swapped = repeat % 2 === 1;
            const prompt = swapped
                ? buildPairwisePrompt(problem, b, a, criterion, options.groundTruthNote)
                : buildPairwisePrompt(problem, a, b, criterion, options.groundTruthNote);
            let last = { criterion: criterion.id, repeat, rewardA: NEUTRAL_SCORE, rewardB: NEUTRAL_SCORE, source: 'error' };
            for (let attempt = 0; attempt <= retries; attempt++) {
                const started = Date.now();
                try {
                    const completion = await options.backend.complete({
                        prompt,
                        maxTokens: options.maxTokens,
                        temperature: options.temperature,
                        logprobs: options.backend.supportsLogprobs,
                        topLogprobs: options.topLogprobs,
                        ...options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {},
                        ...options.signal !== undefined ? { signal: options.signal } : {},
                    });
                    const slotA = extractScore(completion.text, completion.tokens, PAIRWISE_TAG_A, pairwiseValue);
                    const slotB = extractScore(completion.text, completion.tokens, PAIRWISE_TAG_B, pairwiseValue);
                    const source = slotA.source === 'fallback' || slotB.source === 'fallback' ? 'fallback' : slotA.source;
                    options.onCall?.({
                        kind: 'pairwise',
                        criterion: criterion.id,
                        repeat,
                        durationMs: Date.now() - started,
                        source,
                        ...completion.usage?.cachedTokens !== undefined ? { cachedTokens: completion.usage.cachedTokens } : {},
                        ...completion.usage?.promptTokens !== undefined ? { promptTokens: completion.usage.promptTokens } : {},
                        ...completion.usage?.completionTokens !== undefined ? { completionTokens: completion.usage.completionTokens } : {},
                    });
                    // Swap the scores back into candidate order.
                    last = swapped
                        ? { criterion: criterion.id, repeat, rewardA: slotB.score, rewardB: slotA.score, source }
                        : { criterion: criterion.id, repeat, rewardA: slotA.score, rewardB: slotB.score, source };
                }
                catch (error) {
                    options.onCall?.({ kind: 'pairwise', criterion: criterion.id, repeat, durationMs: Date.now() - started, source: 'error', error: String(error) });
                    if (options.onError === 'raise')
                        throw error;
                    last = { criterion: criterion.id, repeat, rewardA: NEUTRAL_SCORE, rewardB: NEUTRAL_SCORE, source: 'error' };
                }
                if (isScored(last.source))
                    break;
            }
            return last;
        }) })), options.warmPrefix ?? true);
    // Only real verdicts enter the directed reward; unscored samples stay visible in `samples`.
    const scored = samples.filter(sample => isScored(sample.source));
    const pool = scored.length > 0 ? scored : samples;
    const rewardA = pool.reduce((sum, sample) => sum + sample.rewardA, 0) / Math.max(1, pool.length);
    const rewardB = pool.reduce((sum, sample) => sum + sample.rewardB, 0) / Math.max(1, pool.length);
    return { rewardA, rewardB, samples };
}
/** One directed pairwise reward (R_a, R_b) in [0, 1]. */
export async function compare(problem, a, b, options) {
    if (a === b)
        return { rewardA: NEUTRAL_SCORE, rewardB: NEUTRAL_SCORE, samples: [] };
    return scoreDirectedPair(problem, a, b, options, limiter(options.concurrency));
}
/** Best-of-N selection with the probabilistic pivot tournament. */
export async function select(problem, candidates, options) {
    if (candidates.length === 0)
        throw new Error('dsh-verifier: select needs at least one candidate');
    const run = limiter(options.concurrency);
    const cache = new Map();
    const scorePair = async (a, b) => {
        const key = `${a},${b}`;
        let pending = cache.get(key);
        if (pending === undefined) {
            const candidateA = candidates[a];
            const candidateB = candidates[b];
            pending = candidateA === candidateB
                ? Promise.resolve({ rewardA: NEUTRAL_SCORE, rewardB: NEUTRAL_SCORE, samples: [] })
                : scoreDirectedPair(problem, candidateA, candidateB, options, run);
            cache.set(key, pending);
        }
        const result = await pending;
        return [result.rewardA, result.rewardB];
    };
    const tournament = await pivotTournament(candidates.length, options.pivots, options.seed, scorePair);
    return {
        index: tournament.best,
        best: candidates[tournament.best],
        scores: tournament.means,
        ranking: tournament.ranking,
        comparisons: tournament.comparisons,
        pivots: tournament.pivots,
    };
}
/** Whether a sample carries a real verdict (logprobs or a literal letter) rather than a neutral placeholder. */
function isScored(source) {
    return source === 'logprobs' || source === 'text';
}
/**
 * Single-trajectory assessment: mean progress-scale reward over criteria × repeats.
 * A completion without a parseable score (`fallback`) or a failed call is retried
 * up to `retriesOnFallback` times; what still has no verdict is excluded from the
 * means instead of counting as a neutral 0.5, and reported as unscored.
 */
export async function assess(problem, trajectory, options) {
    const run = limiter(options.concurrency);
    const retries = options.retriesOnFallback ?? 1;
    const jobs = [];
    for (const criterion of options.criteria) {
        for (let repeat = 0; repeat < options.evaluations; repeat++)
            jobs.push({ criterion, repeat });
    }
    const samples = await runWarm(jobs.map(({ criterion, repeat }) => ({ key: 'assess', run: () => run(async () => {
            const prompt = buildAssessmentPrompt(problem, trajectory, criterion, options.groundTruthNote);
            let last = { score: NEUTRAL_SCORE, analysis: '', source: 'error' };
            for (let attempt = 0; attempt <= retries; attempt++) {
                const started = Date.now();
                try {
                    const completion = await options.backend.complete({
                        prompt,
                        maxTokens: options.maxTokens,
                        temperature: options.temperature,
                        logprobs: options.backend.supportsLogprobs,
                        topLogprobs: options.topLogprobs,
                        ...options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {},
                        ...options.signal !== undefined ? { signal: options.signal } : {},
                    });
                    const extracted = extractScore(completion.text, completion.tokens, ASSESS_TAG, progressValue);
                    options.onCall?.({
                        kind: 'assess',
                        criterion: criterion.id,
                        repeat,
                        durationMs: Date.now() - started,
                        source: extracted.source,
                        ...completion.usage?.cachedTokens !== undefined ? { cachedTokens: completion.usage.cachedTokens } : {},
                        ...completion.usage?.promptTokens !== undefined ? { promptTokens: completion.usage.promptTokens } : {},
                        ...completion.usage?.completionTokens !== undefined ? { completionTokens: completion.usage.completionTokens } : {},
                    });
                    last = { score: extracted.score, analysis: analysisBefore(completion.text, ASSESS_TAG), source: extracted.source };
                }
                catch (error) {
                    options.onCall?.({ kind: 'assess', criterion: criterion.id, repeat, durationMs: Date.now() - started, source: 'error', error: String(error) });
                    if (options.onError === 'raise')
                        throw error;
                    last = { score: NEUTRAL_SCORE, analysis: `verifier call failed: ${String(error)}`, source: 'error' };
                }
                if (isScored(last.source))
                    break;
            }
            return last;
        }) })), options.warmPrefix ?? true);
    const perCriterion = options.criteria.map((criterion) => {
        const repeats = jobs.map((job, index) => job.criterion === criterion ? samples[index] : undefined).filter((sample) => sample !== undefined);
        const scored = repeats.filter(sample => isScored(sample.source));
        const score = scored.length === 0 ? NEUTRAL_SCORE : scored.reduce((sum, sample) => sum + sample.score, 0) / scored.length;
        // Keep the analysis of the harshest scored repeat: that is the most useful feedback.
        const pool = scored.length > 0 ? scored : repeats;
        const harshest = pool.reduce((low, sample) => sample.score < low.score ? sample : low, pool[0]);
        return { id: criterion.id, name: criterion.name, score, analysis: harshest.analysis, source: harshest.source, scored: scored.length > 0 };
    });
    const valid = perCriterion.filter(entry => entry.scored);
    const score = valid.length === 0 ? NEUTRAL_SCORE : valid.reduce((sum, entry) => sum + entry.score, 0) / valid.length;
    return { score, perCriterion, scoredCriteria: valid.length };
}
/**
 * One-checkpoint progress score of a running trajectory (the reference
 * `ProgressTracker.update`): K repeats of the progress prompt, letter only,
 * averaged over the repeats that produced a verdict.
 */
export async function progress(problem, trajectory, nSteps, options) {
    const run = limiter(options.concurrency);
    const prompt = buildProgressPrompt(problem, trajectory, nSteps);
    const retries = options.retriesOnFallback ?? 1;
    const jobs = Array.from({ length: Math.max(1, options.evaluations) }, (_, repeat) => ({ key: 'progress', run: () => run(async () => {
            let last = { score: NEUTRAL_SCORE, source: 'error' };
            for (let attempt = 0; attempt <= retries; attempt++) {
                const started = Date.now();
                try {
                    const completion = await options.backend.complete({
                        prompt,
                        maxTokens: options.maxTokens,
                        temperature: options.temperature,
                        logprobs: options.backend.supportsLogprobs,
                        topLogprobs: options.topLogprobs,
                        ...options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {},
                        ...options.signal !== undefined ? { signal: options.signal } : {},
                    });
                    const extracted = extractScore(completion.text, completion.tokens, PROGRESS_TAG, progressValue);
                    options.onCall?.({ kind: 'assess', criterion: 'progress', repeat, durationMs: Date.now() - started, source: extracted.source });
                    last = { score: extracted.score, source: extracted.source };
                }
                catch (error) {
                    options.onCall?.({ kind: 'assess', criterion: 'progress', repeat, durationMs: Date.now() - started, source: 'error', error: String(error) });
                    last = { score: NEUTRAL_SCORE, source: 'error' };
                }
                if (isScored(last.source))
                    break;
            }
            return last;
        }) }));
    const samples = await runWarm(jobs, options.warmPrefix ?? true);
    const scored = samples.filter(sample => isScored(sample.source));
    return {
        score: scored.length === 0 ? NEUTRAL_SCORE : scored.reduce((sum, sample) => sum + sample.score, 0) / scored.length,
        scoredRepeats: scored.length,
        sources: samples.map(sample => sample.source),
    };
}
//# sourceMappingURL=verifier.js.map