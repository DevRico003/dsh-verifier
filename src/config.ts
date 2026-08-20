/**
 * Plugin configuration: the composition entry (cordis.patch.yml `config:`)
 * is the base of the hot-reloadable `verifier:` settings section.
 */

import z from '@deepseek-ai/schemastery'

export interface BackendConfig {
  /** `openai-compatible` calls the endpoint directly with logprobs; `harness` routes through `ctx.llm` (text-only scores). */
  kind: 'openai-compatible' | 'harness'
  /** OpenAI-compatible base URL (kind `openai-compatible`). */
  baseURL: string
  /** Model id sent to the endpoint (`openai-compatible`) or the harness provider's model (`harness`). */
  model: string
  /** Harness provider route (kind `harness`). */
  provider: string
  /** Environment variable / credential reference holding the API key for `openai-compatible`; empty = no auth header. */
  apiKeyEnv: string
  /** Verifier reasoning effort sent as `reasoning_effort`. The reference verifies DeepSeek V4 Flash at `high` with a 32k budget; `none` is the cheap setting; empty string sends nothing. */
  reasoningEffort: string
  /** Per-call timeout. */
  timeoutMs: number
  /** Output cap per verifier call (analysis + score tags). */
  maxTokens: number
  /** Sampling temperature (the reference uses 1.0 so the logprob distribution is informative). */
  temperature: number
  /** `top_logprobs` requested (20 = one alternative per scale letter; the OpenAI API cap). */
  topLogprobs: number
  /** Concurrent verifier calls. */
  concurrency: number
  /** Re-ask when a verifier reply has no parseable score or the call failed; unscored verdicts never count as 0.5. */
  retriesOnFallback: number
  /** Run the first call of a shared prompt prefix to completion before fanning out the rest, so a prefix-caching server serves the trajectory from cache. */
  warmPrefix: boolean
}

export interface GateConfig {
  /** Verify every turn at `agent/turn-stopping`. */
  enabled: boolean
  /** Minimum mean reward (0..1) for a turn to pass. */
  threshold: number
  /** Forced continuations per turn before the verifier lets the turn close. */
  maxRounds: number
  /** Repeated evaluations per criterion (K). */
  evaluations: number
  /** Built-in criteria set for the gate: general | coding | terminal. */
  criteria: string
  /** `auto` picks `coding` when the turn used tools, else `general`; any set name pins it. */
  criteriaMode: 'auto' | 'fixed'
  /** Skip turns whose final message asks the user a question (forcing continuation would answer on the user's behalf). */
  skipWhenAskingUser: boolean
  /** Skip turns shorter than this many agent steps (0 = verify everything). */
  minSteps: number
  /** Skip child agents (subagents / agent-team members, detected via `session.meta.parentSession`); the parent's turn is verified instead. */
  skipSubagents: boolean
  /** Tool names that mark a turn as deliberately handed back to the user; such turns are never forced on. */
  handoffTools: string[]
  /** Maximum characters of verifier analysis quoted back to the agent. */
  feedbackMaxChars: number
  /** Whole-gate deadline; on expiry the turn closes unverified. */
  timeoutMs: number
}

export interface SelectConfig {
  /** K for the pairwise tools. */
  evaluations: number
  /** Pivot count k for the tournament. */
  pivots: number
  /** Tournament seed (ring order). */
  seed: number
  /** Default criteria set for the pairwise tools. */
  criteria: string
}

export interface TrajectoryConfig {
  maxStepChars: number
  maxTotalChars: number
}

export interface SnapshotConfig {
  /** Register the `ui_snapshot` tool (headless Playwright screenshots for visual evidence). */
  enabled: boolean
  /** Browser channels tried in order: `chrome` = installed Google Chrome, `chromium` = Playwright's own build. */
  channels: string[]
  /** Headless launch; keep true so nothing opens on the user's screen. */
  headless: boolean
  /** Default viewports as WIDTHxHEIGHT. */
  viewports: string[]
  /** Extra wait after load before the shot. */
  settleMs: number
  /** Navigation timeout per page. */
  navigationTimeoutMs: number
  /** Output root; empty = `$DSH_HOME/verifier/snapshots`. */
  dir: string
}

export interface Config {
  /** Master switch. */
  enabled: boolean
  backend: BackendConfig
  gate: GateConfig
  select: SelectConfig
  trajectory: TrajectoryConfig
  snapshot: SnapshotConfig
  /** Register the `verifier_*` tools. */
  tools: boolean
  /** Log every verifier call at info level. */
  verbose: boolean
}

export const BackendConfig: z<BackendConfig> = z.object({
  kind: z.union(['openai-compatible', 'harness']).default('openai-compatible'),
  baseURL: z.string().default('http://127.0.0.1:8000/v1'),
  model: z.string().default('default'),
  provider: z.string().default('spark'),
  apiKeyEnv: z.string().default(''),
  reasoningEffort: z.string().default('high'),
  timeoutMs: z.number().default(600_000),
  maxTokens: z.number().default(32_768),
  temperature: z.number().default(1.0),
  topLogprobs: z.number().default(20),
  concurrency: z.number().default(4),
  retriesOnFallback: z.number().default(1),
  warmPrefix: z.boolean().default(true),
})

export const GateConfig: z<GateConfig> = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().default(0.6),
  maxRounds: z.number().default(1),
  evaluations: z.number().default(1),
  criteria: z.string().default('general'),
  criteriaMode: z.union(['auto', 'fixed']).default('auto'),
  skipWhenAskingUser: z.boolean().default(true),
  minSteps: z.number().default(1),
  skipSubagents: z.boolean().default(true),
  handoffTools: z.array(z.string()).default(['ask_user', 'ask_user_question', 'AskUserQuestion']),
  feedbackMaxChars: z.number().default(2500),
  timeoutMs: z.number().default(900_000),
})

export const SelectConfig: z<SelectConfig> = z.object({
  evaluations: z.number().default(2),
  pivots: z.number().default(1),
  seed: z.number().default(0),
  criteria: z.string().default('general'),
})

export const TrajectoryConfig: z<TrajectoryConfig> = z.object({
  maxStepChars: z.number().default(6000),
  maxTotalChars: z.number().default(300_000),
})

export const SnapshotConfig: z<SnapshotConfig> = z.object({
  enabled: z.boolean().default(true),
  channels: z.array(z.string()).default(['chrome', 'chromium']),
  headless: z.boolean().default(true),
  viewports: z.array(z.string()).default(['1440x900', '390x844']),
  settleMs: z.number().default(500),
  navigationTimeoutMs: z.number().default(30_000),
  dir: z.string().default(''),
})

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  backend: BackendConfig.default({} as BackendConfig),
  gate: GateConfig.default({} as GateConfig),
  select: SelectConfig.default({} as SelectConfig),
  trajectory: TrajectoryConfig.default({} as TrajectoryConfig),
  snapshot: SnapshotConfig.default({} as SnapshotConfig),
  tools: z.boolean().default(true),
  verbose: z.boolean().default(false),
})

/** Fail-loud checks beyond what the schema expresses. */
export function validateConfig(config: Config): void {
  const { backend, gate, select } = config
  if (gate.threshold < 0 || gate.threshold > 1) throw new Error(`dsh-verifier: gate.threshold must be within [0, 1], got ${gate.threshold}`)
  if (!Number.isInteger(gate.maxRounds) || gate.maxRounds < 0) throw new Error(`dsh-verifier: gate.maxRounds must be an integer >= 0, got ${gate.maxRounds}`)
  if (!Number.isInteger(gate.evaluations) || gate.evaluations < 1) throw new Error(`dsh-verifier: gate.evaluations must be an integer >= 1`)
  if (!Number.isInteger(select.evaluations) || select.evaluations < 1) throw new Error(`dsh-verifier: select.evaluations must be an integer >= 1`)
  if (!Number.isInteger(select.pivots) || select.pivots < 1) throw new Error(`dsh-verifier: select.pivots must be an integer >= 1`)
  if (!Number.isInteger(backend.topLogprobs) || backend.topLogprobs < 1 || backend.topLogprobs > 20) throw new Error(`dsh-verifier: backend.topLogprobs must be an integer in [1, 20]`)
  if (!Number.isInteger(backend.concurrency) || backend.concurrency < 1) throw new Error(`dsh-verifier: backend.concurrency must be an integer >= 1`)
  if (backend.kind === 'openai-compatible' && !/^https?:\/\//.test(backend.baseURL)) throw new Error(`dsh-verifier: backend.baseURL must be an http(s) URL, got "${backend.baseURL}"`)
}
