/**
 * Plugin configuration: the composition entry (cordis.patch.yml `config:`)
 * is the base of the hot-reloadable `verifier:` settings section.
 */
import z from '@deepseek-ai/schemastery';
export const BackendConfig = z.object({
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
});
export const GateConfig = z.object({
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
});
export const SelectConfig = z.object({
    evaluations: z.number().default(2),
    pivots: z.number().default(1),
    seed: z.number().default(0),
    criteria: z.string().default('general'),
});
export const TrajectoryConfig = z.object({
    maxStepChars: z.number().default(6000),
    maxTotalChars: z.number().default(300_000),
});
export const SnapshotConfig = z.object({
    enabled: z.boolean().default(true),
    channels: z.array(z.string()).default(['chrome', 'chromium']),
    headless: z.boolean().default(true),
    viewports: z.array(z.string()).default(['1440x900', '390x844']),
    settleMs: z.number().default(500),
    navigationTimeoutMs: z.number().default(30_000),
    dir: z.string().default(''),
});
export const CheckpointConfig = z.object({
    enabled: z.boolean().default(true),
    minSteps: z.number().default(40),
    everySteps: z.number().default(40),
    evaluations: z.number().default(1),
    threshold: z.number().default(0.3),
    drop: z.number().default(0.25),
    minRise: z.number().default(0.05),
    maxSteers: z.number().default(3),
    gateDebtEdits: z.number().default(12),
    editTools: z.array(z.string()).default(['write', 'edit', 'str_replace_editor', 'apply_patch', 'notebook_edit']),
    timeoutMs: z.number().default(900_000),
});
export const Config = z.object({
    enabled: z.boolean().default(true),
    backend: BackendConfig.default({}),
    gate: GateConfig.default({}),
    select: SelectConfig.default({}),
    trajectory: TrajectoryConfig.default({}),
    snapshot: SnapshotConfig.default({}),
    checkpoint: CheckpointConfig.default({}),
    tools: z.boolean().default(true),
    verbose: z.boolean().default(false),
});
/** Fail-loud checks beyond what the schema expresses. */
export function validateConfig(config) {
    const { backend, gate, select } = config;
    if (gate.threshold < 0 || gate.threshold > 1)
        throw new Error(`dsh-verifier: gate.threshold must be within [0, 1], got ${gate.threshold}`);
    if (!Number.isInteger(gate.maxRounds) || gate.maxRounds < 0)
        throw new Error(`dsh-verifier: gate.maxRounds must be an integer >= 0, got ${gate.maxRounds}`);
    if (!Number.isInteger(gate.evaluations) || gate.evaluations < 1)
        throw new Error(`dsh-verifier: gate.evaluations must be an integer >= 1`);
    if (!Number.isInteger(select.evaluations) || select.evaluations < 1)
        throw new Error(`dsh-verifier: select.evaluations must be an integer >= 1`);
    if (!Number.isInteger(select.pivots) || select.pivots < 1)
        throw new Error(`dsh-verifier: select.pivots must be an integer >= 1`);
    if (!Number.isInteger(backend.topLogprobs) || backend.topLogprobs < 1 || backend.topLogprobs > 20)
        throw new Error(`dsh-verifier: backend.topLogprobs must be an integer in [1, 20]`);
    if (!Number.isInteger(backend.concurrency) || backend.concurrency < 1)
        throw new Error(`dsh-verifier: backend.concurrency must be an integer >= 1`);
    if (config.checkpoint.threshold < 0 || config.checkpoint.threshold > 1)
        throw new Error(`dsh-verifier: checkpoint.threshold must be within [0, 1]`);
    if (!Number.isInteger(config.checkpoint.everySteps) || config.checkpoint.everySteps < 1)
        throw new Error(`dsh-verifier: checkpoint.everySteps must be an integer >= 1`);
    if (backend.kind === 'openai-compatible' && !/^https?:\/\//.test(backend.baseURL))
        throw new Error(`dsh-verifier: backend.baseURL must be an http(s) URL, got "${backend.baseURL}"`);
}
//# sourceMappingURL=config.js.map