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
}
export interface Trajectory {
    /** Task text: the user's prompt(s) that opened this turn. */
    task: string;
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
/**
 * Build the trajectory of turn `turn` from the session's event log.
 * @param events - full ordered session log.
 * @param turn - the turn number to serialize.
 * @param limits - character caps.
 */
export declare function buildTrajectory(events: readonly SessionEvent[], turn: number, limits: TrajectoryLimits): Trajectory;
