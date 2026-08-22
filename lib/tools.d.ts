/**
 * Model-facing tools so the agent can verify on demand:
 *  - `verifier_select`: best-of-N over candidate answers/patches/plans (pivot tournament)
 *  - `verifier_compare`: one directed pairwise reward
 *  - `verifier_assess`: strict single-answer assessment against the task
 * All three run with the backend's reasoning effort, the same as the gate.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import type { VerifierBackend } from './core/backend.js';
import { type Log } from './gate.js';
export interface ToolDeps {
    config: () => Config;
    backend: () => VerifierBackend;
    log: Log;
}
export declare function installTools(ctx: Context, deps: ToolDeps): void;
