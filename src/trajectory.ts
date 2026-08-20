/**
 * Serialize the current turn of a harness session into the verifier's
 * trajectory format (the reference loaders' `--- Agent Step n ---` /
 * `[Tool call]` / `[Output]` shape), bounded by character caps.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface TrajectoryLimits {
  /** Cap per tool output / message excerpt. */
  maxStepChars: number
  /** Cap for the whole serialized trajectory (oldest steps are elided first). */
  maxTotalChars: number
  /** When a turn is a continuation (it opens with "Continue."), prepend this many earlier turns so the verifier sees the work they hold (default 1). */
  continuationTurns?: number
}

export interface Trajectory {
  /** Task text: the user's prompt(s) that opened this turn. */
  task: string
  /** Serialized steps. */
  trace: string
  steps: number
  toolCalls: number
  toolErrors: number
  /** The last non-empty assistant text of the turn. */
  finalText: string
  /** Name of the last tool the agent called in this turn, if any. */
  lastToolName?: string
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}... (truncated, +${text.length - cap} chars)`
}

/** Sources whose message text is the task itself (the human, or the goal plugin's objective). */
export function isTaskSource(source: { kind: string }): boolean {
  return source.kind === 'user' || source.kind === 'goal'
}

function blockText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * Build the trajectory of turn `turn` from the session's event log.
 * @param events - full ordered session log.
 * @param turn - the turn number to serialize.
 * @param limits - character caps.
 */
export function buildTrajectory(events: readonly SessionEvent[], turn: number, limits: TrajectoryLimits): Trajectory {
  const own = buildTurn(events, turn, limits)
  const back = limits.continuationTurns ?? 1
  if (back <= 0 || turn <= 1 || !isContinuation(own.firstTask)) return own
  // Continuation turns (auto-continue after an interruption, a goal round that
  // resumes) hold little of the work; the previous turn holds the edits and the
  // command output the verifier needs. Prepend it, oldest first, within the cap.
  const earlier: string[] = []
  for (let t = Math.max(1, turn - back); t < turn; t++) {
    const previous = buildTurn(events, t, limits)
    if (previous.trace.trim() !== '') earlier.push(`=== Earlier turn ${t} (${previous.steps} steps) ===\n${previous.trace}`)
  }
  if (earlier.length === 0) return own
  const combined = `${earlier.join('\n\n')}\n\n=== Current turn ${turn} ===\n${own.trace}`
  const trace = combined.length > limits.maxTotalChars
    ? `(earlier content elided)\n\n${combined.slice(combined.length - limits.maxTotalChars)}`
    : combined
  return { ...own, trace }
}

/** A turn that opens with "Continue." (auto-continue, goal resume) rather than a fresh request. */
export function isContinuation(firstTask: string): boolean {
  return /^\s*Continue\b/i.test(firstTask)
}

function buildTurn(events: readonly SessionEvent[], turn: number, limits: TrajectoryLimits): Trajectory & { firstTask: string } {
  let inTurn = false
  // The goal objective of a multi-turn goal run lives in an earlier turn; a later
  // turn often opens with "Continue." only. Carry the latest objective forward so
  // the verifier judges against the goal, not against "Continue.".
  let goalObjective = ''
  let goalInThisTurn = false
  const taskParts: string[] = []
  let firstTask = ''
  const pluginContexts: string[] = []
  const steps: string[] = []
  let current: string[] = []
  let stepNumber = 0
  let toolCalls = 0
  let toolErrors = 0
  let finalText = ''
  let lastToolName: string | undefined

  const flush = (): void => {
    if (current.length === 0) return
    stepNumber++
    steps.push(`--- Agent Step ${stepNumber} ---\n${current.join('\n')}`)
    current = []
  }

  for (const event of events) {
    if (event.type === 'turn/start') {
      if (event.data.turn === turn) inTurn = true
      else if (inTurn) break
      continue
    }
    if (!inTurn) {
      if (event.type === 'user/message' && (event.data.source.kind as string) === 'goal') goalObjective = blockText(event.data.content)
      continue
    }
    switch (event.type) {
      case 'user/message': {
        const text = blockText(event.data.content)
        if ((event.data.source.kind as string) === 'goal') goalInThisTurn = true
        // The task is what the human or the goal asked for. A goal round arrives with
        // `source.kind: 'goal'`; everything else (instructions, runtime snapshots,
        // plugin notices) is context for the verifier, not the task.
        if (isTaskSource(event.data.source)) {
          if (taskParts.length === 0) firstTask = text
          taskParts.push(text)
        }
        else if (text !== '') pluginContexts.push(truncate(text, limits.maxStepChars))
        break
      }
      case 'assistant/message': {
        flush()
        const text = blockText(event.data.message.content)
        if (text.trim() !== '') {
          current.push(truncate(text, limits.maxStepChars))
          finalText = text
        }
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            toolCalls++
            lastToolName = block.name
            current.push(`[Tool call] ${block.name} ${truncate(block.arguments, limits.maxStepChars)}`)
          }
        }
        break
      }
      case 'tool/result': {
        const content = event.data.message.content[0]
        const output = content === undefined ? '' : blockText(content.content)
        const isError = content?.isError === true || event.data.error !== undefined
        if (isError) toolErrors++
        current.push(`[Output${isError ? ' ERROR' : ''}] ${truncate(output === '' ? '(no output)' : output, limits.maxStepChars)}`)
        break
      }
      case 'turn/end':
        break
      default:
        break
    }
  }
  flush()

  // Elide the oldest steps first when the whole trace exceeds the cap.
  let kept = steps
  let trace = kept.join('\n\n')
  let elided = 0
  while (trace.length > limits.maxTotalChars && kept.length > 1) {
    kept = kept.slice(1)
    elided++
    trace = `(${elided} earlier step(s) elided)\n\n${kept.join('\n\n')}`
  }
  if (trace.length > limits.maxTotalChars) trace = truncate(trace, limits.maxTotalChars)

  const contextNote = pluginContexts.length === 0
    ? ''
    : `\n\n[Harness context injected during the turn]\n${pluginContexts.join('\n')}`

  const task = !goalInThisTurn && goalObjective !== ''
    ? [`Goal objective (set in an earlier turn):\n${goalObjective}`, ...taskParts].join('\n\n')
    : taskParts.join('\n\n')

  return {
    task,
    firstTask,
    trace: trace + contextNote,
    steps: stepNumber,
    toolCalls,
    toolErrors,
    finalText,
    ...lastToolName !== undefined ? { lastToolName } : {},
  }
}

export interface VerifierDebt {
  /** File-editing tool calls since the last `verifier_*` call in this turn (or since the turn began). */
  edits: number
  /** Step number of the last `verifier_*` call, 0 when none. */
  lastVerifierStep: number
}

/** Count edits since the agent last asked the verifier, within one turn. */
export function verifierDebt(events: readonly SessionEvent[], turn: number, editTools: readonly string[]): VerifierDebt {
  let inTurn = false
  let step = 0
  let edits = 0
  let lastVerifierStep = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (event.data.turn === turn) inTurn = true
      else if (inTurn) break
      continue
    }
    if (!inTurn || event.type !== 'assistant/message') continue
    step++
    for (const block of event.data.message.content) {
      if (block.type !== 'tool-call') continue
      if (block.name.startsWith('verifier_')) {
        edits = 0
        lastVerifierStep = step
      } else if (editTools.includes(block.name)) {
        edits++
      }
    }
  }
  return { edits, lastVerifierStep }
}

/**
 * Whether an agent is a child (subagent, team member). Checked three ways
 * because hosts differ: `session.meta.parentSession` (current harness),
 * `session.parentSession` / `session.origin === 'subagent'` (session header
 * fields), and a `subagent/descriptor` event, which only child sessions carry.
 */
export function isChildSession(session: { meta?: { parentSession?: unknown }; parentSession?: unknown; origin?: unknown; events: readonly SessionEvent[] }): boolean {
  if (session.meta?.parentSession !== undefined && session.meta.parentSession !== null) return true
  if (session.parentSession !== undefined && session.parentSession !== null) return true
  if (session.origin === 'subagent') return true
  for (const event of session.events) {
    if ((event as { type: string }).type === 'subagent/descriptor') return true
    if (event.type === 'turn/start') break
  }
  return false
}
