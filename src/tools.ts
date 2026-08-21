/**
 * Model-facing tools so the agent can verify on demand:
 *  - `verifier_select`: best-of-N over candidate answers/patches/plans (pivot tournament)
 *  - `verifier_compare`: one directed pairwise reward
 *  - `verifier_assess`: strict single-answer assessment against the task
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.js'
import type { VerifierBackend } from './core/backend.js'
import { CRITERIA_SET_NAMES, resolveCriteria } from './core/prompts.js'
import { assess, compare, select, type VerifierOptions } from './core/verifier.js'
import { buildTrajectory } from './trajectory.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface ToolDeps {
  config: () => Config
  backend: () => VerifierBackend
  /** Optional logger; with `verbose` every verifier call of a tool is logged like the gate's. */
  log?: { info: (message: string) => void }
}

function baseOptions(deps: ToolDeps, criteriaName: string | undefined, evaluations: number, signal: AbortSignal): VerifierOptions {
  const config = deps.config()
  const set = resolveCriteria(criteriaName ?? config.select.criteria)
  return {
    backend: deps.backend(),
    criteria: set.criteria,
    groundTruthNote: set.groundTruthNote,
    evaluations,
    concurrency: config.backend.concurrency,
    maxTokens: config.backend.maxTokens,
    temperature: config.backend.temperature,
    topLogprobs: config.backend.topLogprobs,
    signal,
    onError: 'tie',
    retriesOnFallback: config.backend.retriesOnFallback,
    warmPrefix: config.backend.warmPrefix,
    ...config.backend.toolReasoningEffort !== '' ? { reasoningEffort: config.backend.toolReasoningEffort } : {},
    onCall: config.verbose && deps.log !== undefined
      ? info => deps.log!.info(`dsh-verifier-gate: tool ${info.kind} ${info.criterion}#${info.repeat} ${info.source} ${info.durationMs}ms`
        + (info.promptTokens !== undefined ? ` prompt=${info.promptTokens}` : '')
        + (info.cachedTokens !== undefined ? ` cached=${info.cachedTokens}` : '')
        + (info.error !== undefined ? ` error=${info.error}` : '')
        + (info.detail !== undefined ? ` detail=${info.detail}` : ''))
      : undefined,
  }
}

/** The calling agent's current turn, serialized like the gate does, so the verifier judges observed output rather than the agent's summary. */
function currentTurnTrace(agent: Agent | undefined, limits: Config['trajectory']): string | undefined {
  if (agent === undefined) return undefined
  let turn: number | undefined
  for (const event of agent.session.events) if (event.type === 'turn/start') turn = event.data.turn
  if (turn === undefined) return undefined
  const trajectory = buildTrajectory(agent.session.events, turn, limits)
  return trajectory.trace.trim() === '' ? undefined : trajectory.trace
}

const CRITERIA_DESCRIPTION = `Criteria set: ${CRITERIA_SET_NAMES.join(' | ')} (default from settings).`

export function installTools(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'verifier_select',
    description:
      'Best-of-N: an independent verifier compares the candidates pairwise on a 20-point scale (expectation over logprobs), a pivot tournament ranks them. Use it when you have two or more finished alternatives (patches, designs, plans, answers). Returns bestIndex, per-candidate scores and the ranking.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task / question the candidates answer, as the user stated it.' },
      candidates: { type: 'array', required: true, items: { type: 'string' }, description: 'Two or more candidate outputs, full text each.' },
      criteria: { type: 'string', description: CRITERIA_DESCRIPTION },
      evaluations: { type: 'number', description: 'Repeated evaluations per criterion (default from settings).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const { task, candidates, criteria, evaluations } = args as { task: string; candidates: string[]; criteria?: string; evaluations?: number }
      if (!Array.isArray(candidates) || candidates.length < 2) throw new Error('verifier_select needs at least two candidates')
      const config = deps.config()
      const result = await select(task, candidates, {
        ...baseOptions(deps, criteria, evaluations ?? config.select.evaluations, exec.signal),
        pivots: config.select.pivots,
        seed: config.select.seed,
      })
      return {
        bestIndex: result.index,
        best: result.best,
        scores: result.scores.map(score => Number(score.toFixed(4))),
        ranking: result.ranking,
        comparisons: result.comparisons,
        pivots: result.pivots,
        backend: deps.backend().label,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'verifier_compare',
    description:
      'One directed pairwise verification of two candidates for a task. Returns rewardA and rewardB in 0..1; slot bias cancels across repeats. Use it for exactly two alternatives.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task / question.' },
      a: { type: 'string', required: true, description: 'Candidate A, full text.' },
      b: { type: 'string', required: true, description: 'Candidate B, full text.' },
      criteria: { type: 'string', description: CRITERIA_DESCRIPTION },
      evaluations: { type: 'number', description: 'Repeated evaluations per criterion (default from settings; 2+ cancels slot bias).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const { task, a, b, criteria, evaluations } = args as { task: string; a: string; b: string; criteria?: string; evaluations?: number }
      const config = deps.config()
      const result = await compare(task, a, b, baseOptions(deps, criteria, evaluations ?? config.select.evaluations, exec.signal))
      return {
        rewardA: Number(result.rewardA.toFixed(4)),
        rewardB: Number(result.rewardB.toFixed(4)),
        preferred: result.rewardA === result.rewardB ? 'tie' : result.rewardA > result.rewardB ? 'A' : 'B',
        samples: result.samples.map(sample => ({ criterion: sample.criterion, repeat: sample.repeat, rewardA: Number(sample.rewardA.toFixed(3)), rewardB: Number(sample.rewardB.toFixed(3)), source: sample.source })),
        backend: deps.backend().label,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'verifier_assess',
    description:
      'Gate for one result: an independent verifier scores it per criterion (0..1, expectation over logprobs) and returns findings that name what is wrong, missing or unverified. Call it after a node that changed more than one file, before a merge, and before the final answer. Put the observed evidence (command output, test results) in answer; by default the verifier also reads this turn\'s trajectory. pass is true at or above the threshold; scoredCriteria 0 means the backend failed, not a verdict.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task / question as stated by the user.' },
      answer: { type: 'string', required: true, description: 'The draft answer or a summary of the work done, including observed evidence.' },
      criteria: { type: 'string', description: CRITERIA_DESCRIPTION },
      evaluations: { type: 'number', description: 'Repeated evaluations per criterion (default 1).' },
      includeTrajectory: { type: 'boolean', description: 'Also give the verifier the observed trajectory of your current turn (tool calls and their outputs), so it judges evidence rather than your summary. Default true.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const { task, answer, criteria, evaluations, includeTrajectory } = args as { task: string; answer: string; criteria?: string; evaluations?: number; includeTrajectory?: boolean }
      const config = deps.config()
      const trace = includeTrajectory === false ? undefined : currentTurnTrace(exec.agent, { ...config.trajectory, maxTotalChars: config.trajectory.toolMaxTotalChars })
      const trajectory = trace === undefined
        ? `--- Agent final answer ---\n${answer}`
        : `${trace}\n\n--- Agent final answer (self-reported) ---\n${answer}`
      const result = await assess(task, trajectory, baseOptions(deps, criteria, evaluations ?? config.toolEvaluations, exec.signal))
      return {
        score: Number(result.score.toFixed(4)),
        pass: result.scoredCriteria > 0 && result.score >= config.gate.threshold,
        threshold: config.gate.threshold,
        scoredCriteria: result.scoredCriteria,
        trajectoryIncluded: trace !== undefined,
        criteria: result.perCriterion.map(entry => ({ id: entry.id, score: entry.scored ? Number(entry.score.toFixed(4)) : null, scored: entry.scored, source: entry.source, findings: entry.analysis })),
        backend: deps.backend().label,
      }
    },
  }))
}
