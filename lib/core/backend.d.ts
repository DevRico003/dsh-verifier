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
    /** Per-call `reasoning_effort`; overrides the backend default when set. */
    reasoningEffort?: string;
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
/** Hosts like `YOUR_SPARK_HOST` that a checkout ships instead of a real endpoint. */
export declare function placeholderHost(baseURL: string): string | undefined;
/**
 * Backend standing in while `backend.baseURL` still holds a placeholder: every
 * call fails with the fix spelled out, so the gate warns and the tools tell the
 * agent what to report instead of a bare DNS error.
 */
export declare class UnconfiguredBackend implements VerifierBackend {
    readonly label: string;
    readonly supportsLogprobs = false;
    readonly reason: string;
    constructor(baseURL: string, host: string);
    complete(): Promise<Completion>;
}
export interface OpenAICompatibleOptions {
    baseURL: string;
    model: string;
    apiKey?: string;
    /** Sent as `reasoning_effort` when set (vLLM accepts none|low|high|max for DeepSeek V4). */
    reasoningEffort?: string;
    /** Extra request fields merged into the JSON body (e.g. `chat_template_kwargs`). */
    extraBody?: Record<string, unknown>;
    /** Hard cap per call. */
    timeoutMs: number;
    /** Abort when no token arrives for this long (streaming keeps the connection alive while the model thinks). */
    idleTimeoutMs?: number;
    fetchImpl?: typeof fetch;
}
interface ParsedCompletion {
    text: string;
    tokens: TokenLogprob[];
    finishReason?: string;
    reasoningChars: number;
    usage: {
        promptTokens?: number;
        completionTokens?: number;
        cachedTokens?: number;
    };
}
/** Parse an OpenAI-style SSE stream; `onChunk` runs for every chunk (the idle timer's heartbeat). */
export declare function readEventStream(body: ReadableStream<Uint8Array>, onChunk: () => void): Promise<ParsedCompletion>;
export declare class OpenAICompatibleBackend implements VerifierBackend {
    private readonly options;
    readonly label: string;
    readonly supportsLogprobs = true;
    /** Node's global fetch gives up on response headers after 300 s; a thinking verifier on a long trajectory can take longer, so the dispatcher follows `timeoutMs`. */
    private readonly dispatcher;
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
export {};
