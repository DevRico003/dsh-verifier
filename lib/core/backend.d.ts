/**
 * Verifier model backends.
 *
 * - `OpenAICompatibleBackend`: direct chat-completions call with
 *   `logprobs` + `top_logprobs`, which is what makes the fine-grained
 *   expectation score possible (vLLM / SGLang / DeepSeek API all serve it).
 * - `HarnessLlmBackend`: routes through the harness `ctx.llm` seam (any
 *   configured provider), text-only, so scores degrade to the literal letter.
 */
import type { TokenLogprob } from './scoring.js';
export interface CompletionRequest {
    prompt: string;
    system?: string;
    maxTokens: number;
    temperature: number;
    /** Request token logprobs (ignored by backends that cannot serve them). */
    logprobs: boolean;
    topLogprobs: number;
    signal?: AbortSignal;
}
export interface Completion {
    text: string;
    tokens?: TokenLogprob[];
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        cachedTokens?: number;
    };
}
export interface VerifierBackend {
    /** Human-readable route description for logs. */
    readonly label: string;
    /** Whether this backend can return token logprobs. */
    readonly supportsLogprobs: boolean;
    complete(request: CompletionRequest): Promise<Completion>;
}
export interface OpenAICompatibleOptions {
    baseURL: string;
    model: string;
    apiKey?: string;
    /** Sent as `reasoning_effort` when set (vLLM accepts none|low|high|max for DeepSeek V4). */
    reasoningEffort?: string;
    /** Extra request fields merged into the JSON body (e.g. `chat_template_kwargs`). */
    extraBody?: Record<string, unknown>;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
}
export declare class OpenAICompatibleBackend implements VerifierBackend {
    private readonly options;
    readonly label: string;
    readonly supportsLogprobs = true;
    constructor(options: OpenAICompatibleOptions);
    complete(request: CompletionRequest): Promise<Completion>;
}
/** Minimal view of the harness LLM seam this backend needs (kept structural to avoid a hard type dependency). */
export interface HarnessLlmLike {
    stream(options: {
        provider: string;
        model: string;
        reasoningEffort?: string;
        messages: unknown[];
        system?: string;
        temperature?: number;
        maxTokens?: number;
        signal?: AbortSignal;
    }): AsyncIterable<unknown>;
}
export interface HarnessLlmBackendOptions {
    provider: string;
    model: string;
    reasoningEffort?: string;
    timeoutMs: number;
    createUserMessage: (text: string) => unknown;
    collectText: (chunks: AsyncIterable<unknown>) => Promise<string>;
}
export declare class HarnessLlmBackend implements VerifierBackend {
    private readonly llm;
    private readonly options;
    readonly label: string;
    readonly supportsLogprobs = false;
    constructor(llm: HarnessLlmLike, options: HarnessLlmBackendOptions);
    complete(request: CompletionRequest): Promise<Completion>;
}
