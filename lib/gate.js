/**
 * End-of-turn quality gate. At `agent/turn-stopping` the current turn is
 * serialized, assessed by the verifier, and, when the reward is below the
 * threshold, the verifier's concrete findings are steered back to the agent
 * as a plugin-sourced message, which makes the machine run another step.
 * Continuations are capped per turn (`maxRounds`) and every steer is durable
 * in the session log (a `user/message` with `source.kind: 'plugin'`), so the
 * model-visible ⟺ logged rule holds.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveCriteria } from './core/prompts.js';
import { assess } from './core/verifier.js';
import { buildTrajectory } from './trajectory.js';
export const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-verifier' };
/** Render the steering feedback the agent receives. */
export function renderFeedback(result, threshold, round, maxRounds, maxChars) {
    const sorted = [...result.perCriterion].sort((a, b) => a.score - b.score);
    const lines = [];
    lines.push(`[dsh-verifier] Automatic verification of your last turn scored ${result.score.toFixed(2)} / 1.00 (pass threshold ${threshold.toFixed(2)}). Round ${round} of ${maxRounds}.`);
    lines.push('Per-criterion rewards: ' + sorted.map(entry => `${entry.name}=${entry.scored ? entry.score.toFixed(2) : 'unscored'}`).join(', ') + '.');
    lines.push('');
    let budget = maxChars;
    for (const entry of sorted) {
        if (!entry.scored || entry.analysis.trim() === '' || budget <= 0)
            continue;
        const excerpt = entry.analysis.length > budget ? `${entry.analysis.slice(0, budget)}…` : entry.analysis;
        budget -= excerpt.length;
        lines.push(`Verifier findings, ${entry.name} (${entry.score.toFixed(2)}):`);
        lines.push(excerpt);
        lines.push('');
    }
    lines.push('Address these findings concretely before finishing: fix what is wrong or missing, run the relevant verification with tools where possible and show the observed output, then give the final answer. If a finding is mistaken, state briefly why and finish.');
    return lines.join('\n');
}
/** A subagent / team member: its session records the parent session it was spawned or forked from. */
function isChildAgent(agent) {
    const meta = agent.session.meta;
    return meta?.parentSession !== undefined && meta.parentSession !== null;
}
function looksLikeQuestionToUser(text) {
    const lines = text.trim().split('\n').map(line => line.trim()).filter(line => line !== '');
    const last = lines.at(-1);
    return last !== undefined && /[?？]$/.test(last);
}
/** Decide whether a trajectory is eligible for the gate; returns a reason to skip or undefined. */
export function skipReason(trajectory, config) {
    if (trajectory.task.trim() === '')
        return 'no user task in this turn';
    if (trajectory.finalText.trim() === '' && trajectory.toolCalls === 0)
        return 'empty turn';
    if (trajectory.steps < config.minSteps)
        return `fewer than ${config.minSteps} step(s)`;
    if (trajectory.lastToolName !== undefined && config.handoffTools.includes(trajectory.lastToolName))
        return `hand-off tool ${trajectory.lastToolName}`;
    if (config.skipWhenAskingUser && looksLikeQuestionToUser(trajectory.finalText))
        return 'final message asks the user a question';
    return undefined;
}
/** Install the gate on every agent the context sees. */
export function installGate(ctx, deps) {
    const states = new WeakMap();
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
        const config = deps.config();
        if (!config.enabled || !config.gate.enabled)
            return;
        if (signal.aborted)
            return;
        const gate = config.gate;
        if (gate.skipSubagents && isChildAgent(agent)) {
            deps.log.debug(`dsh-verifier: skipping child agent ${agent.id} (gate.skipSubagents)`);
            return;
        }
        const state = states.get(agent);
        const current = state !== undefined && state.turn === turn ? state : { turn, rounds: 0, lastScore: undefined };
        states.set(agent, current);
        if (current.rounds >= gate.maxRounds) {
            deps.log.info(`dsh-verifier: turn ${turn} of ${agent.id} reached maxRounds=${gate.maxRounds}; closing (last score ${current.lastScore?.toFixed(2) ?? 'n/a'})`);
            return;
        }
        const trajectory = buildTrajectory(agent.session.events, turn, config.trajectory);
        const skip = skipReason(trajectory, gate);
        if (skip !== undefined) {
            deps.log.debug(`dsh-verifier: skipping turn ${turn} of ${agent.id}: ${skip}`);
            return;
        }
        const setName = gate.criteriaMode === 'auto' ? (trajectory.toolCalls > 0 ? 'coding' : 'general') : gate.criteria;
        const criteria = resolveCriteria(gate.criteriaMode === 'auto' && gate.criteria !== 'general' && gate.criteria !== 'coding' ? gate.criteria : setName);
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(gate.timeoutMs)]);
        const options = {
            backend: deps.backend(),
            criteria: criteria.criteria,
            groundTruthNote: criteria.groundTruthNote,
            evaluations: gate.evaluations,
            concurrency: config.backend.concurrency,
            maxTokens: config.backend.maxTokens,
            temperature: config.backend.temperature,
            topLogprobs: config.backend.topLogprobs,
            signal: deadline,
            onError: 'tie',
            retriesOnFallback: config.backend.retriesOnFallback,
            onCall: config.verbose
                ? info => deps.log.info(`dsh-verifier: ${info.kind} ${info.criterion}#${info.repeat} ${info.source} ${info.durationMs}ms`
                    + (info.promptTokens !== undefined ? ` prompt=${info.promptTokens}` : '')
                    + (info.cachedTokens !== undefined ? ` cached=${info.cachedTokens}` : '')
                    + (info.error !== undefined ? ` error=${info.error}` : ''))
                : undefined,
        };
        const started = Date.now();
        let result;
        try {
            result = await assess(trajectory.task, trajectory.trace, options);
        }
        catch (error) {
            deps.log.warn(`dsh-verifier: assessment failed for turn ${turn} of ${agent.id}: ${String(error)}`);
            return;
        }
        if (deadline.aborted) {
            deps.log.warn(`dsh-verifier: assessment of turn ${turn} timed out; closing unverified`);
            return;
        }
        const summary = result.perCriterion.map(entry => `${entry.id}=${entry.scored ? entry.score.toFixed(2) : 'unscored'}/${entry.source}`).join(' ');
        if (result.scoredCriteria === 0) {
            deps.log.warn(`dsh-verifier: turn ${turn} of ${agent.id} produced no scorable verdict (${summary}); closing unverified`);
            return;
        }
        current.lastScore = result.score;
        if (result.score >= gate.threshold) {
            deps.log.info(`dsh-verifier: turn ${turn} of ${agent.id} PASSED ${result.score.toFixed(2)} >= ${gate.threshold} (${summary}, ${Date.now() - started}ms, round ${current.rounds})`);
            return;
        }
        current.rounds++;
        deps.log.info(`dsh-verifier: turn ${turn} of ${agent.id} BELOW threshold ${result.score.toFixed(2)} < ${gate.threshold} (${summary}, ${Date.now() - started}ms); steering round ${current.rounds}/${gate.maxRounds}`);
        const text = renderFeedback(result, gate.threshold, current.rounds, gate.maxRounds, gate.feedbackMaxChars);
        agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }));
    });
}
//# sourceMappingURL=gate.js.map