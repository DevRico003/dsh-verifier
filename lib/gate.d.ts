/**
 * End-of-turn quality gate. At `agent/turn-stopping` the current turn is
 * serialized, assessed by the verifier, and, when the reward is below the
 * threshold, the verifier's concrete findings are steered back to the agent
 * as a plugin-sourced message, which makes the machine run another step.
 * Continuations are capped per turn (`maxRounds`) and every steer is durable
 * in the session log (a `user/message` with `source.kind: 'plugin'`), so the
 * model-visible ⟺ logged rule holds.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MessageSource } from '@deepseek-ai/dsh-llm';
import type { Config } from './config.js';
import { type AssessResult } from './core/verifier.js';
import type { VerifierBackend } from './core/backend.js';
import { type Trajectory } from './trajectory.js';
export declare const PLUGIN_SOURCE: MessageSource;
export interface GateDeps {
    /** Current configuration (hot-reloaded). */
    config: () => Config;
    /** Current backend (rebuilt on settings change). */
    backend: () => VerifierBackend;
    log: {
        info: (message: string) => void;
        warn: (message: string) => void;
        debug: (message: string) => void;
    };
}
/** Render the steering feedback the agent receives. */
export declare function renderFeedback(result: AssessResult, threshold: number, round: number, maxRounds: number, maxChars: number): string;
/** Decide whether a trajectory is eligible for the gate; returns a reason to skip or undefined. */
export declare function skipReason(trajectory: Trajectory, config: Config['gate']): string | undefined;
/** Install the gate on every agent the context sees. */
export declare function installGate(ctx: Context, deps: GateDeps): void;
