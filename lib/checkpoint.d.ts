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
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import { type AssessResult } from './core/verifier.js';
import type { VerifierBackend } from './core/backend.js';
export interface CheckpointDeps {
    config: () => Config;
    backend: () => VerifierBackend;
    log: {
        info: (message: string) => void;
        warn: (message: string) => void;
        debug: (message: string) => void;
    };
}
/**
 * Pure decision: does this progress score call for a steer? The first
 * checkpoint only sets the baseline: a long goal reads low early by design.
 * From the second on, a fall by `drop`, or a reading that stays below
 * `threshold` without rising by `minRise`, is the reference's plateau or
 * regression pattern and earns a steer.
 */
export declare function checkpointTrigger(score: number, previous: number | undefined, threshold: number, drop: number, minRise: number): string | undefined;
/** The checkpoint message: the measured progress, then the assessment's findings. */
export declare function renderCheckpoint(step: number, progressScore: number, reason: string, result: AssessResult, threshold: number, maxChars: number): string;
export declare function renderDebtNudge(edits: number): string;
export declare function installCheckpoint(ctx: Context, deps: CheckpointDeps): void;
