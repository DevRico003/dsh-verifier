/**
 * Serialize the current turn of a harness session into the verifier's
 * trajectory format (the reference loaders' `--- Agent Step n ---` /
 * `[Tool call]` / `[Output]` shape), bounded by character caps.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
export interface TrajectoryLimits {
    /** Cap per tool output / message excerpt. */
    maxStepChars: number;
    /** Cap for the whole serialized trajectory (oldest steps are elided first). */
    maxTotalChars: number;
    /** When a turn is a continuation (it opens with "Continue."), prepend this many earlier turns so the verifier sees the work they hold (default 1). */
    continuationTurns?: number;
}
export interface Trajectory {
    /** Task text: the user's prompt(s) that opened this turn. */
    task: string;
    /** Whether this turn carries its own task message (user or goal round), as opposed to a carried-forward goal objective only. */
    ownTask: boolean;
    /** Serialized steps. */
    trace: string;
    steps: number;
    toolCalls: number;
    toolErrors: number;
    /** The last non-empty assistant text of the turn. */
    finalText: string;
    /** Name of the last tool the agent called in this turn, if any. */
    lastToolName?: string;
}
/** Sources whose message text is the task itself (the human, or the goal plugin's objective). */
export declare function isTaskSource(source: {
    kind: string;
}): boolean;
/**
 * Build the trajectory of turn `turn` from the session's event log.
 * @param events - full ordered session log.
 * @param turn - the turn number to serialize.
 * @param limits - character caps.
 */
export declare function buildTrajectory(events: readonly SessionEvent[], turn: number, limits: TrajectoryLimits): Trajectory;
/**
 * Join the steps within `cap` characters. When they do not fit, keep the
 * opening steps (the task setup and first decisions, up to HEAD_SHARE of the
 * cap) and the most recent steps, and elide the middle. The head is the same
 * on every call, so a prefix-caching server reuses it across the gates of one
 * turn; the tail carries the evidence the verifier judges.
 */
export declare function elideMiddle(steps: readonly string[], cap: number): string;
/** A turn that opens with "Continue." (auto-continue, goal resume) rather than a fresh request. */
export declare function isContinuation(firstTask: string): boolean;
export interface VerifierDebt {
    /** File-editing tool calls since the last `verifier_*` call in this turn (or since the turn began). */
    edits: number;
    /** Step number of the last `verifier_*` call, 0 when none. */
    lastVerifierStep: number;
}
/** Count edits since the agent last asked the verifier, within one turn. */
export declare function verifierDebt(events: readonly SessionEvent[], turn: number, editTools: readonly string[]): VerifierDebt;
/**
 * Whether an agent is a child (subagent, team member). Checked three ways
 * because hosts differ: `session.meta.parentSession` (current harness),
 * `session.parentSession` / `session.origin === 'subagent'` (session header
 * fields), and a `subagent/descriptor` event, which only child sessions carry.
 */
export declare function isChildSession(session: {
    meta?: {
        parentSession?: unknown;
    };
    parentSession?: unknown;
    origin?: unknown;
    events: readonly SessionEvent[];
}): boolean;
