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
  let inTurn = false
  const taskParts: string[] = []
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
    if (!inTurn) continue
    switch (event.type) {
      case 'user/message': {
        const text = blockText(event.data.content)
        if (event.data.source.kind === 'user') taskParts.push(text)
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

  return {
    task: taskParts.join('\n\n'),
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
