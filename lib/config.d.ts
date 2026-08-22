/**
 * Plugin configuration: the composition entry (cordis.patch.yml `config:`)
 * is the base of the hot-reloadable `verifier:` settings section.
 */
import z from '@deepseek-ai/schemastery';
export interface BackendConfig {
    /** OpenAI-compatible chat-completions base URL; the endpoint must return `logprobs`. */
    baseURL: string;
    /** Model id sent to the endpoint. */
    model: string;
    /** Environment variable / credential reference holding the API key; empty = no Authorization header. */
    apiKeyEnv: string;
    /** Sent as `reasoning_effort` on every verifier call (gate and tools). `high` is the reference setting; `low` is about three times faster with close verdicts; `none` is a one-shot reading; empty sends nothing. */
    reasoningEffort: string;
    /** Hard cap per verifier call. Generous on purpose: thinking is never cut short, the idle timer catches a dead stream. */
    timeoutMs: number;
    /** Abort a call when the stream delivers nothing for this long. */
    idleTimeoutMs: number;
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
    /** Run the first call of a shared prompt prefix to completion before fanning out the rest, so a prefix-caching server serves the trajectory from cache. Saves prefill work at the price of doubling wall-clock; on a local vLLM with fast prefill leave it off. */
    warmPrefix: boolean;
}
export interface GateConfig {
    /** Verify every turn at `agent/turn-stopping`. */
    enabled: boolean;
    /** Minimum mean reward (0..1) for a turn to pass. */
    threshold: number;
    /** Forced continuations per turn before the verifier lets the turn close. */
    maxRounds: number;
    /** Repeated evaluations per criterion (K); also the default K of `verifier_assess`. */
    evaluations: number;
    /** Criteria set: `auto` picks `coding` when the turn used tools and `general` otherwise; or a set name (general | coding | terminal). */
    criteria: string;
    /** Skip turns whose final message asks the user a question (forcing continuation would answer on the user's behalf). */
    skipWhenAskingUser: boolean;
    /** A turn opened only by a relay (subagent report, plugin notice), not by the user or a goal round, is gated only when it made at least this many tool calls. */
    minToolCallsWithoutOwnTask: number;
    /** Skip child agents (subagents / agent-team members); the parent's turn is verified instead. */
    skipSubagents: boolean;
    /** Tool names that mark a turn as deliberately handed back to the user; such turns are never forced on. */
    handoffTools: string[];
    /** Maximum characters of verifier analysis quoted back to the agent. */
    feedbackMaxChars: number;
    /** Whole-gate deadline; on expiry the turn closes unverified. */
    timeoutMs: number;
}
export interface SelectConfig {
    /** K for `verifier_select` and `verifier_compare`. */
    evaluations: number;
    /** Pivot count k for the tournament. */
    pivots: number;
    /** Tournament seed (ring order). */
    seed: number;
    /** Default criteria set for the pairwise tools. */
    criteria: string;
}
export interface TrajectoryConfig {
    /** Cap per tool output / message excerpt. */
    maxStepChars: number;
    /** Cap for the whole serialized turn; over it the middle is elided, the opening and the most recent steps stay. */
    maxTotalChars: number;
    /** Earlier turns prepended when a turn is a continuation ("Continue."). */
    continuationTurns: number;
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
export interface Config {
    /** Master switch. */
    enabled: boolean;
    backend: BackendConfig;
    gate: GateConfig;
    select: SelectConfig;
    trajectory: TrajectoryConfig;
    snapshot: SnapshotConfig;
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
export declare const Config: z<Config>;
/** Fail-loud checks beyond what the schema expresses. */
export declare function validateConfig(config: Config): void;
