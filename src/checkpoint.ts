/**
 * Mid-turn checkpoints, so one long turn gets verified while it runs instead
 * of only at its end. Two mechanisms, both observing `agent/pre-step`:
 *
 * - Progress checkpoint: every `everySteps` steps the turn so far is scored
 *   with the reference progress prompt (one letter, K repeats). When the score
 *   is below `threshold`, or fell by `drop` since the previous checkpoint, the
 *   turn is assessed with findings and the agent is steered. Scoring runs in
 *   the background; the agent keeps working until the verdict lands.
 * - Gate debt: when the agent has edited `gateDebtEdits` files since its last
 *   `verifier_*` call, one reminder is steered (no model call).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'
import { resolveCriteria } from './core/prompts.js'
import { assess, progress, type AssessResult, type VerifierOptions } from './core/verifier.js'
import type { VerifierBackend } from './core/backend.js'
import { isChildAgent, PLUGIN_SOURCE, renderFeedback } from './gate.js'
import { buildTrajectory, verifierDebt } from './trajectory.js'

interface CheckpointState {
  turn: number
  lastCheckpointStep: number
  lastScore: number | undefined
  /** Consecutive low readings without a rise; a steer needs `stallReadings` of them. */
  stalls: number
  steers: number
  inFlight: boolean
  /** A triggered checkpoint waiting to be assessed and delivered at the next step boundary. */
  pending: { step: number; score: number; reason: string } | undefined
  assessing: boolean
  debtNudgedAt: number | undefined
  /** Edit count at the last nudge; the reminder repeats every `gateDebtEdits` further edits. */
  debtNudgedEdits: number
}

export interface CheckpointDeps {
  config: () => Config
  backend: () => VerifierBackend
  log: { info: (message: string) => void; warn: (message: string) => void; debug: (message: string) => void }
}

/**
 * Pure decision: does this progress score call for a steer? The first
 * checkpoint only sets the baseline: a long goal reads low early by design.
 * From the second on, a fall by `drop`, or a reading that stays below
 * `threshold` without rising by `minRise`, is the reference's plateau or
 * regression pattern and earns a steer.
 */
export function checkpointTrigger(score: number, previous: number | undefined, threshold: number, drop: number, minRise: number): string | undefined {
  if (previous === undefined) return undefined
  if (previous - score >= drop) return `progress fell from ${previous.toFixed(2)} to ${score.toFixed(2)}`
  if (score < threshold && score < previous + minRise) return `progress ${score.toFixed(2)} stalled below ${threshold.toFixed(2)} (previous ${previous.toFixed(2)})`
  return undefined
}

/** The checkpoint message: the measured progress, then the assessment's findings. */
export function renderCheckpoint(step: number, progressScore: number, reason: string, result: AssessResult, threshold: number, maxChars: number): string {
  const head = `[dsh-verifier-gate checkpoint] Step ${step}: the verifier scored the turn so far at ${progressScore.toFixed(2)} / 1.00 progress (${reason}). This is a mid-turn reading, not the end-of-turn gate.`
  const body = renderFeedback(result, threshold, 0, 0, maxChars).split('\n').slice(2).join('\n')
  return `${head}\n${body}`
}

export function renderDebtNudge(edits: number, repeat = 0): string {
  const base = `[dsh-verifier-gate] ${edits} file edits since your last verifier call. Per graph-verified-coding a node that changed more than one file is gated before the next one starts: run the proving command, then verifier_assess with criteria "coding", the node's contract as task and the observed evidence as answer. Continue after the gate.`
  if (repeat === 0) return base
  return `${base} This is reminder ${repeat + 1}: the work since the last gate is now several nodes deep and unverified; gate what is finished before the next edit, even if the current node is not complete (gate it as partial, name what is open).`
}

export function installCheckpoint(ctx: Context, deps: CheckpointDeps): void {
  const states = new WeakMap<Agent, CheckpointState>()

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    const config = deps.config()
    const checkpoint = config.checkpoint
    if (decision.kind === 'reject' || signal.aborted || !config.enabled || !checkpoint.enabled) return decision
    if (config.gate.skipSubagents && isChildAgent(agent)) return decision
    const previous = states.get(agent)
    const state: CheckpointState = previous !== undefined && previous.turn === turn
      ? previous
      : { turn, lastCheckpointStep: 0, lastScore: undefined, stalls: 0, steers: 0, inFlight: false, pending: undefined, assessing: false, debtNudgedAt: undefined, debtNudgedEdits: 0 }
    states.set(agent, state)

    // Gate debt: cheap, no model call.
    if (checkpoint.gateDebtEdits > 0) {
      const debt = verifierDebt(agent.session.events, turn, checkpoint.editTools)
      const newPeriod = state.debtNudgedAt !== debt.lastVerifierStep
      if (debt.edits >= checkpoint.gateDebtEdits && (newPeriod || debt.edits >= state.debtNudgedEdits + checkpoint.gateDebtEdits)) {
        const repeat = newPeriod ? 0 : Math.floor(debt.edits / checkpoint.gateDebtEdits) - 1
        state.debtNudgedAt = debt.lastVerifierStep
        state.debtNudgedEdits = debt.edits
        deps.log.info(`dsh-verifier-gate: turn ${turn} step ${step} of ${agent.id}: ${debt.edits} edits since the last verifier call; nudging${repeat > 0 ? ` (repeat ${repeat})` : ''}`)
        agent.steer(createUserMessage({ content: [{ type: 'text', text: renderDebtNudge(debt.edits, repeat) }], source: PLUGIN_SOURCE }))
      }
    }

    // A triggered checkpoint is assessed and delivered HERE, before the step runs, so the
    // agent does not move on while the verifier judges a state that is already history:
    // the findings describe the state the agent is in when it reads them.
    if (state.pending !== undefined && !state.assessing && checkpoint.deliver === 'blocking') {
      const pending = state.pending
      state.pending = undefined
      state.assessing = true
      try {
        const text = await assessForSteer(agent, turn, pending, config, deps, signal)
        if (text !== undefined) {
          state.steers++
          const message = createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE })
          if (decision.kind === 'enter') decision.messages.push(message)
          else agent.steer(message)
        }
      } finally {
        state.assessing = false
      }
    }

    // Progress checkpoint, in the background.
    if (step < checkpoint.minSteps || step - state.lastCheckpointStep < checkpoint.everySteps) return decision
    if (state.inFlight || state.steers >= checkpoint.maxSteers) return decision
    state.lastCheckpointStep = step
    state.inFlight = true
    void runCheckpoint(agent, turn, step, state, config, deps, signal).finally(() => { state.inFlight = false })
    return decision
  })
}

async function runCheckpoint(agent: Agent, turn: number, step: number, state: CheckpointState, config: Config, deps: CheckpointDeps, signal: AbortSignal): Promise<void> {
  const checkpoint = config.checkpoint
  const trajectory = buildTrajectory(agent.session.events, turn, config.trajectory)
  if (trajectory.task.trim() === '' || trajectory.steps === 0) return
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(checkpoint.timeoutMs)])
  const base = {
    backend: deps.backend(),
    concurrency: config.backend.concurrency,
    maxTokens: config.backend.maxTokens,
    temperature: config.backend.temperature,
    topLogprobs: config.backend.topLogprobs,
    signal: deadline,
    warmPrefix: config.backend.warmPrefix,
    ...checkpoint.reasoningEffort !== '' ? { reasoningEffort: checkpoint.reasoningEffort } : {},
    onCall: config.verbose
      ? (info: { kind: string; criterion: string; repeat: number; source: string; durationMs: number; error?: string }) => deps.log.info(`dsh-verifier-gate: checkpoint ${info.kind} ${info.criterion}#${info.repeat} ${info.source} ${info.durationMs}ms${info.error !== undefined ? ` error=${info.error}` : ''}${info.detail !== undefined ? ` detail=${info.detail}` : ''}`)
      : undefined,
  }
  const started = Date.now()
  let measured
  try {
    measured = await progress(trajectory.task, trajectory.trace, trajectory.steps, { ...base, evaluations: checkpoint.evaluations, retriesOnFallback: config.backend.retriesOnFallback })
  } catch (error) {
    deps.log.warn(`dsh-verifier-gate: checkpoint at step ${step} of ${agent.id} failed: ${String(error)}`)
    return
  }
  if (deadline.aborted || measured.scoredRepeats === 0) {
    deps.log.warn(`dsh-verifier-gate: checkpoint at step ${step} of ${agent.id} produced no verdict (${measured.sources.join(',')})`)
    return
  }
  let reason = checkpointTrigger(measured.score, state.lastScore, checkpoint.threshold, checkpoint.drop, checkpoint.minRise)
  // One low reading on a long goal is noise; a fall is acted on at once, a stall only once it persists.
  if (reason !== undefined && reason.includes('stalled')) {
    state.stalls++
    if (state.stalls < checkpoint.stallReadings) reason = undefined
  } else if (reason === undefined) state.stalls = 0
  deps.log.info(`dsh-verifier-gate: checkpoint turn ${turn} step ${step} of ${agent.id}: progress ${measured.score.toFixed(2)} (previous ${state.lastScore?.toFixed(2) ?? 'n/a'}, stalls ${state.stalls}, ${Date.now() - started}ms)${reason !== undefined ? `; steering: ${reason}` : ''}`)
  state.lastScore = measured.score
  if (reason === undefined) return
  state.stalls = 0
  if (config.checkpoint.deliver === 'blocking') {
    // Hand over to the next step boundary, where the assessment runs while the agent waits.
    state.pending = { step, score: measured.score, reason }
    return
  }
  const idle = (): boolean => (agent.status as string) === 'idle'
  if (idle()) return
  const text = await assessForSteer(agent, turn, { step, score: measured.score, reason }, config, deps, signal)
  if (text === undefined || idle()) return
  state.steers++
  agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
}

/** Assess the turn as it is now and render the checkpoint message; undefined when no verdict could be formed. */
async function assessForSteer(agent: Agent, turn: number, pending: { step: number; score: number; reason: string }, config: Config, deps: CheckpointDeps, signal: AbortSignal): Promise<string | undefined> {
  const checkpoint = config.checkpoint
  const trajectory = buildTrajectory(agent.session.events, turn, config.trajectory)
  if (trajectory.task.trim() === '') return undefined
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(checkpoint.timeoutMs)])
  const set = resolveCriteria(config.gate.criteriaMode === 'auto' ? (trajectory.toolCalls > 0 ? 'coding' : 'general') : config.gate.criteria)
  const options: VerifierOptions = {
    backend: deps.backend(),
    criteria: set.criteria,
    groundTruthNote: set.groundTruthNote,
    evaluations: 1,
    concurrency: config.backend.concurrency,
    maxTokens: config.backend.maxTokens,
    temperature: config.backend.temperature,
    topLogprobs: config.backend.topLogprobs,
    signal: deadline,
    onError: 'tie',
    retriesOnFallback: config.backend.retriesOnFallback,
    warmPrefix: config.backend.warmPrefix,
    ...checkpoint.reasoningEffort !== '' ? { reasoningEffort: checkpoint.reasoningEffort } : {},
  }
  const started = Date.now()
  let result: AssessResult
  try {
    result = await assess(trajectory.task, trajectory.trace, options)
  } catch (error) {
    deps.log.warn(`dsh-verifier-gate: checkpoint assessment (trigger at step ${pending.step}) of ${agent.id} failed: ${String(error)}`)
    return undefined
  }
  if (result.scoredCriteria === 0) {
    deps.log.warn(`dsh-verifier-gate: checkpoint assessment (trigger at step ${pending.step}) of ${agent.id} produced no verdict`)
    return undefined
  }
  deps.log.info(`dsh-verifier-gate: checkpoint steer for ${agent.id} (trigger step ${pending.step}, ${pending.reason}): assessed ${result.score.toFixed(2)} in ${Date.now() - started}ms, delivering`)
  return renderCheckpoint(pending.step, pending.score, pending.reason, result, config.gate.threshold, config.gate.feedbackMaxChars)
}
