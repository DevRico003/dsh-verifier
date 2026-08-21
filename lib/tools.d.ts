/**
 * Model-facing tools so the agent can verify on demand:
 *  - `verifier_select`: best-of-N over candidate answers/patches/plans (pivot tournament)
 *  - `verifier_compare`: one directed pairwise reward
 *  - `verifier_assess`: strict single-answer assessment against the task
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import type { VerifierBackend } from './core/backend.js';
export interface ToolDeps {
    config: () => Config;
    backend: () => VerifierBackend;
    /** Optional logger; with `verbose` every verifier call of a tool is logged like the gate's. */
    log?: {
        info: (message: string) => void;
    };
}
export declare function installTools(ctx: Context, deps: ToolDeps): void;
