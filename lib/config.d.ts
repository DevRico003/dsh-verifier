/**
 * Plugin configuration: the composition entry (cordis.patch.yml `config:`)
 * is the base of the hot-reloadable `verifier:` settings section.
 */
import z from '@deepseek-ai/schemastery';
export interface BackendConfig {
    /** `openai-compatible` calls the endpoint directly with logprobs; `harness` routes through `ctx.llm` (text-only scores). */
    kind: 'openai-compatible' | 'harness';
    /** OpenAI-compatible base URL (kind `openai-compatible`). */
    baseURL: string;
    /** Model id sent to the endpoint (`openai-compatible`) or the harness provider's model (`harness`). */
    model: string;
    /** Harness provider route (kind `harness`). */
    provider: string;
    /** Environment variable / credential reference holding the API key for `openai-compatible`; empty = no auth header. */
    apiKeyEnv: string;
    /** Verifier reasoning effort sent as `reasoning_effort`. The reference verifies DeepSeek V4 Flash at `high` with a 32k budget; `none` is the cheap setting; empty string sends nothing. */
    reasoningEffort: string;
    /** Per-call timeout. */
    timeoutMs: number;
    /** Output cap per verifier call (analysis + score tags). */
    maxTokens: number;
    /** Sampling temperature (the reference uses 1.0 so the logprob distribution is informative). */
    temperature: number;
    /** `top_logprobs` requested (20 = one alternative per scale letter; the OpenAI API cap). */
    topLogprobs: number;
    /** Concurrent verifier calls. */
    concurrency: number;
    /** Re-ask when a verifier reply has no parseable score or the call failed; unscored verdicts never count as 0.5. */
    retriesOnFallback: number;
    /** Run the first call of a shared prompt prefix to completion before fanning out the rest, so a prefix-caching server serves the trajectory from cache. */
    warmPrefix: boolean;
}
export interface GateConfig {
    /** Verify every turn at `agent/turn-stopping`. */
    enabled: boolean;
    /** Minimum mean reward (0..1) for a turn to pass. */
    threshold: number;
    /** Forced continuations per turn before the verifier lets the turn close. */
    maxRounds: number;
    /** Repeated evaluations per criterion (K). */
    evaluations: number;
    /** Built-in criteria set for the gate: general | coding | terminal. */
    criteria: string;
    /** `auto` picks `coding` when the turn used tools, else `general`; any set name pins it. */
    criteriaMode: 'auto' | 'fixed';
    /** Skip turns whose final message asks the user a question (forcing continuation would answer on the user's behalf). */
    skipWhenAskingUser: boolean;
    /** Skip turns shorter than this many agent steps (0 = verify everything). */
    minSteps: number;
    /** Skip child agents (subagents / agent-team members, detected via `session.meta.parentSession`); the parent's turn is verified instead. */
    skipSubagents: boolean;
    /** Tool names that mark a turn as deliberately handed back to the user; such turns are never forced on. */
    handoffTools: string[];
    /** Maximum characters of verifier analysis quoted back to the agent. */
    feedbackMaxChars: number;
    /** Whole-gate deadline; on expiry the turn closes unverified. */
    timeoutMs: number;
}
export interface SelectConfig {
    /** K for the pairwise tools. */
    evaluations: number;
    /** Pivot count k for the tournament. */
    pivots: number;
    /** Tournament seed (ring order). */
    seed: number;
    /** Default criteria set for the pairwise tools. */
    criteria: string;
}
export interface TrajectoryConfig {
    maxStepChars: number;
    maxTotalChars: number;
}
export interface SnapshotConfig {
    /** Register the `ui_snapshot` tool (headless Playwright screenshots for visual evidence). */
    enabled: boolean;
    /** Browser channels tried in order: `chrome` = installed Google Chrome, `chromium` = Playwright's own build. */
    channels: string[];
    /** Headless launch; keep true so nothing opens on the user's screen. */
    headless: boolean;
    /** Default viewports as WIDTHxHEIGHT. */
    viewports: string[];
    /** Extra wait after load before the shot. */
    settleMs: number;
    /** Navigation timeout per page. */
    navigationTimeoutMs: number;
    /** Output root; empty = `$DSH_HOME/verifier/snapshots`. */
    dir: string;
}
export interface CheckpointConfig {
    /** Score the running turn at step boundaries and steer when progress is low or falling. */
    enabled: boolean;
    /** First checkpoint at this step. */
    minSteps: number;
    /** Steps between checkpoints. */
    everySteps: number;
    /** Repeats of the progress prompt per checkpoint (K). */
    evaluations: number;
    /** Steer when progress is below this. */
    threshold: number;
    /** Steer when progress fell by at least this since the previous checkpoint. */
    drop: number;
    /** Checkpoint steers per turn. */
    maxSteers: number;
    /** Remind the agent to gate after this many file edits without a `verifier_*` call (0 = off). */
    gateDebtEdits: number;
    /** Tool names that count as file edits. */
    editTools: string[];
    /** Deadline per checkpoint (progress plus assessment). */
    timeoutMs: number;
}
export interface Config {
    /** Master switch. */
    enabled: boolean;
    backend: BackendConfig;
    gate: GateConfig;
    select: SelectConfig;
    trajectory: TrajectoryConfig;
    snapshot: SnapshotConfig;
    checkpoint: CheckpointConfig;
    /** Register the `verifier_*` tools. */
    tools: boolean;
    /** Log every verifier call at info level. */
    verbose: boolean;
}
export declare const BackendConfig: z<BackendConfig>;
export declare const GateConfig: z<GateConfig>;
export declare const SelectConfig: z<SelectConfig>;
export declare const TrajectoryConfig: z<TrajectoryConfig>;
export declare const SnapshotConfig: z<SnapshotConfig>;
export declare const CheckpointConfig: z<CheckpointConfig>;
export declare const Config: z<Config>;
/** Fail-loud checks beyond what the schema expresses. */
export declare function validateConfig(config: Config): void;
