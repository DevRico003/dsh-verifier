/**
 * dsh-verifier-gate: LLM-as-a-Verifier for DeepSeek Harness.
 *
 * Port of the llm-as-a-verifier method (fine-grained 20-letter scale, reward =
 * expectation over the score-token logprobs, criteria decomposition × repeated
 * evaluation, probabilistic pivot tournament for best-of-N) as a harness
 * plugin: an end-of-turn quality gate plus `verifier_*` tools.
 * @module dsh-verifier-gate
 */
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { Config, validateConfig } from './config.js';
import { OpenAICompatibleBackend, UnconfiguredBackend, placeholderHost } from './core/backend.js';
import { installGate } from './gate.js';
import { installTools } from './tools.js';
import { installSnapshotTool } from './ui-snapshot.js';
export { Config } from './config.js';
export * from './core/scale.js';
export * from './core/scoring.js';
export * from './core/tournament.js';
export * from './core/prompts.js';
export * from './core/verifier.js';
export * from './core/backend.js';
export { buildTrajectory } from './trajectory.js';
export { renderFeedback, skipReason, PLUGIN_SOURCE } from './gate.js';
export const name = 'dsh-verifier-gate';
export const inject = ['tools'];
/** Settings namespace: a `verifier:` section in `$DSH_HOME/settings.yaml` overrides the composition entry without a restart. */
export const VERIFIER_SETTINGS_NAMESPACE = settingsNamespace('verifier');
function resolveApiKey(ctx, reference) {
    if (reference === '')
        return undefined;
    const fromEnv = process.env[reference];
    if (fromEnv !== undefined && fromEnv !== '')
        return fromEnv;
    // Best-effort read of the harness credential store when it exposes a synchronous lookup.
    const credentials = ctx.get('credentials');
    const peeked = credentials?.peek?.(reference);
    return peeked !== undefined && peeked !== '' ? peeked : undefined;
}
function buildBackend(ctx, config) {
    const { backend } = config;
    const placeholder = placeholderHost(backend.baseURL);
    // No warning here: at apply time only the composition base is known and the
    // settings overlay (where the real host lives) has not been applied yet.
    if (placeholder !== undefined)
        return new UnconfiguredBackend(backend.baseURL, placeholder);
    const apiKey = resolveApiKey(ctx, backend.apiKeyEnv);
    return new OpenAICompatibleBackend({
        baseURL: backend.baseURL,
        model: backend.model,
        ...apiKey !== undefined ? { apiKey } : {},
        ...backend.reasoningEffort !== '' ? { reasoningEffort: backend.reasoningEffort } : {},
        timeoutMs: backend.timeoutMs,
        idleTimeoutMs: backend.idleTimeoutMs,
    });
}
/**
 * Mount the verifier: hot-reloadable settings, the turn gate, and the tools.
 * @param ctx - plugin context.
 * @param entry - composition config (base of the `verifier` settings section).
 */
export function apply(ctx, entry) {
    validateConfig(entry);
    let current = () => entry;
    let backend = buildBackend(ctx, entry);
    let backendFor = entry;
    const config = () => {
        const resolved = current();
        if (backendFor !== resolved) {
            try {
                validateConfig(resolved);
                backend = buildBackend(ctx, resolved);
                backendFor = resolved;
            }
            catch (error) {
                ctx.logger.warn(`dsh-verifier-gate: settings rejected, keeping previous backend: ${String(error)}`);
            }
        }
        return backendFor ?? entry;
    };
    const getBackend = () => {
        config();
        return backend;
    };
    const log = {
        info: (message) => ctx.logger.info(message),
        warn: (message) => ctx.logger.warn(message),
        debug: (message) => ctx.logger.debug(message),
    };
    installSettingsSection(ctx, VERIFIER_SETTINGS_NAMESPACE, Config, entry, {
        setSource: source => { current = source; },
        onChange: () => {
            const resolved = config();
            if (backend instanceof UnconfiguredBackend)
                ctx.logger.warn(backend.reason);
            ctx.logger.info(`dsh-verifier-gate: active: backend ${backend.label}, gate ${resolved.gate.enabled ? `on (threshold ${resolved.gate.threshold}, maxRounds ${resolved.gate.maxRounds}, ${resolved.gate.evaluations} repeat(s), criteria ${resolved.gate.criteria})` : 'off'}, tools ${resolved.tools ? 'on' : 'off'}, effort ${resolved.backend.reasoningEffort}, concurrency ${resolved.backend.concurrency}`);
        },
    });
    installGate(ctx, { config, backend: getBackend, log });
    if (entry.tools)
        installTools(ctx, { config, backend: getBackend, log });
    if (entry.tools && entry.snapshot.enabled)
        installSnapshotTool(ctx, config);
}
//# sourceMappingURL=index.js.map