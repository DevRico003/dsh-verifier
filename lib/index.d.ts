/**
 * dsh-verifier-gate: LLM-as-a-Verifier for DeepSeek Harness.
 *
 * Port of the llm-as-a-verifier method (fine-grained 20-letter scale, reward =
 * expectation over the score-token logprobs, criteria decomposition × repeated
 * evaluation, probabilistic pivot tournament for best-of-N) as a harness
 * plugin: an automatic end-of-turn quality gate plus `verifier_*` tools.
 * @module dsh-verifier-gate
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
export { Config } from './config.js';
export type { Config as VerifierConfig } from './config.js';
export * from './core/scale.js';
export * from './core/scoring.js';
export * from './core/tournament.js';
export * from './core/prompts.js';
export * from './core/verifier.js';
export * from './core/backend.js';
export { buildTrajectory } from './trajectory.js';
export { renderFeedback, skipReason } from './gate.js';
export declare const name = "dsh-verifier-gate";
export declare const inject: string[];
/** Settings namespace: a `verifier:` section in `$DSH_HOME/settings.yaml` overrides the composition entry without a restart. */
export declare const VERIFIER_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/**
 * Mount the verifier: hot-reloadable settings, the turn gate, and the tools.
 * @param ctx - plugin context.
 * @param entry - composition config (base of the `verifier` settings section).
 */
export declare function apply(ctx: Context, entry: Config): void;
