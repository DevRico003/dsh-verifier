/**
 * Verifier model backends.
 *
 * `OpenAICompatibleBackend` makes a direct chat-completions call with
 * `logprobs` + `top_logprobs`, which is what makes the fine-grained
 * expectation score possible (vLLM / SGLang / DeepSeek API all serve it).
 */
import { Agent as UndiciAgent } from 'undici';
/** Hosts like `YOUR_SPARK_HOST` that a checkout ships instead of a real endpoint. */
export function placeholderHost(baseURL) {
    // Raw match: `new URL()` lowercases hostnames and would hide the placeholder's spelling.
    const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?\[?([^\]/:?#]+)/i.exec(baseURL)?.[1];
    if (host === undefined)
        return undefined;
    return /^YOUR_|_HOST$|^<.*>$|^example\.(com|org|net)$/i.test(host) ? host : undefined;
}
/**
 * Backend standing in while `backend.baseURL` still holds a placeholder: every
 * call fails with the fix spelled out, so the gate warns and the tools tell the
 * agent what to report instead of a bare DNS error.
 */
export class UnconfiguredBackend {
    label;
    supportsLogprobs = false;
    reason;
    constructor(baseURL, host) {
        this.label = `${baseURL} (unconfigured)`;
        this.reason = `dsh-verifier-gate: backend.baseURL still holds the placeholder "${host}"; set verifier.backend.baseURL (and model) in $DSH_HOME/settings.yaml to your OpenAI-compatible endpoint`;
    }
    complete() {
        return Promise.reject(new Error(this.reason));
    }
}
function composeSignal(a, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return a === undefined ? timeout : AbortSignal.any([a, timeout]);
}
function mapLogprobs(entries) {
    return (entries ?? []).map(entry => ({
        token: entry.token,
        logprob: entry.logprob,
        topLogprobs: (entry.top_logprobs ?? []).map(alt => ({ token: alt.token, logprob: alt.logprob })),
    }));
}
function fromJson(payload) {
    const choice = payload.choices?.[0];
    if (choice === undefined)
        throw new Error('dsh-verifier-gate: backend returned no choices');
    return {
        text: choice.message?.content ?? '',
        tokens: mapLogprobs(choice.logprobs?.content),
        ...choice.finish_reason !== undefined ? { finishReason: choice.finish_reason } : {},
        reasoningChars: (choice.message?.reasoning ?? choice.message?.reasoning_content ?? '').length,
        usage: {
            ...payload.usage?.prompt_tokens !== undefined ? { promptTokens: payload.usage.prompt_tokens } : {},
            ...payload.usage?.completion_tokens !== undefined ? { completionTokens: payload.usage.completion_tokens } : {},
            ...payload.usage?.prompt_tokens_details?.cached_tokens !== undefined ? { cachedTokens: payload.usage.prompt_tokens_details.cached_tokens } : {},
        },
    };
}
/** Parse an OpenAI-style SSE stream; `onChunk` runs for every chunk (the idle timer's heartbeat). */
export async function readEventStream(body, onChunk) {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = '';
    let text = '';
    let reasoningChars = 0;
    let finishReason;
    const tokens = [];
    let usage = {};
    const handle = (line) => {
        if (!line.startsWith('data:'))
            return;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]')
            return;
        let chunk;
        try {
            chunk = JSON.parse(data);
        }
        catch {
            return;
        }
        if (chunk.error !== undefined)
            throw new Error(`dsh-verifier-gate: backend stream error: ${chunk.error.message ?? 'unknown'}`);
        const choice = chunk.choices?.[0];
        if (choice !== undefined) {
            if (choice.delta?.content)
                text += choice.delta.content;
            reasoningChars += (choice.delta?.reasoning ?? choice.delta?.reasoning_content ?? '').length;
            tokens.push(...mapLogprobs(choice.logprobs?.content));
            if (choice.finish_reason)
                finishReason = choice.finish_reason;
        }
        if (chunk.usage) {
            usage = {
                ...chunk.usage.prompt_tokens !== undefined ? { promptTokens: chunk.usage.prompt_tokens } : {},
                ...chunk.usage.completion_tokens !== undefined ? { completionTokens: chunk.usage.completion_tokens } : {},
                ...chunk.usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens } : {},
            };
        }
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        onChunk();
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, at).replace(/\r$/, '');
            buffer = buffer.slice(at + 1);
            handle(line);
        }
    }
    if (buffer.trim() !== '')
        handle(buffer);
    return { text, tokens, ...finishReason !== undefined ? { finishReason } : {}, reasoningChars, usage };
}
export class OpenAICompatibleBackend {
    options;
    label;
    supportsLogprobs = true;
    /** Node's global fetch gives up on response headers after 300 s; a thinking verifier on a long trajectory can take longer, so the dispatcher follows `timeoutMs`. */
    dispatcher;
    constructor(options) {
        this.options = options;
        this.label = `${options.baseURL} · ${options.model}`;
        this.dispatcher = new UndiciAgent({ headersTimeout: options.timeoutMs, bodyTimeout: options.timeoutMs });
    }
    async complete(request) {
        const { options } = this;
        const url = `${options.baseURL.replace(/\/+$/, '')}/chat/completions`;
        const messages = [];
        if (request.system !== undefined && request.system !== '')
            messages.push({ role: 'system', content: request.system });
        messages.push({ role: 'user', content: request.prompt });
        const body = {
            model: options.model,
            messages,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            ...request.logprobs ? { logprobs: true, top_logprobs: request.topLogprobs } : {},
            ...(request.reasoningEffort ?? options.reasoningEffort) !== undefined ? { reasoning_effort: request.reasoningEffort ?? options.reasoningEffort } : {},
            // Stream so a long think never trips a header timeout; the idle timer below guards a stalled stream.
            stream: true,
            stream_options: { include_usage: true },
            ...options.extraBody ?? {},
        };
        const headers = { 'content-type': 'application/json' };
        if (options.apiKey !== undefined && options.apiKey !== '')
            headers['authorization'] = `Bearer ${options.apiKey}`;
        const doFetch = options.fetchImpl ?? fetch;
        const idle = new AbortController();
        const idleMs = options.idleTimeoutMs ?? 300_000;
        let idleTimer;
        const armIdle = () => {
            if (idleTimer !== undefined)
                clearTimeout(idleTimer);
            idleTimer = setTimeout(() => idle.abort(new Error(`dsh-verifier-gate: backend ${this.label} sent nothing for ${idleMs} ms`)), idleMs);
        };
        armIdle();
        let response;
        try {
            response = await doFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.any([composeSignal(request.signal, options.timeoutMs), idle.signal]),
                ...options.fetchImpl === undefined ? { dispatcher: this.dispatcher } : {},
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(`dsh-verifier-gate: backend ${this.label} answered HTTP ${response.status}: ${payload.error?.message ?? 'unknown error'}`);
            }
            const contentType = response.headers.get('content-type') ?? '';
            const parsed = contentType.includes('text/event-stream') && response.body !== null
                ? await readEventStream(response.body, armIdle)
                : fromJson(await response.json());
            if (parsed.text.trim() === '') {
                // With thinking on, a reply that ran out of tokens carries reasoning but no answer, so there is no score to read.
                throw new Error(`dsh-verifier-gate: backend ${this.label} returned no answer text (finish_reason=${parsed.finishReason ?? 'unknown'}, reasoning chars=${parsed.reasoningChars}); raise backend.maxTokens or lower backend.reasoningEffort`);
            }
            return {
                text: parsed.text,
                ...parsed.tokens.length > 0 ? { tokens: parsed.tokens } : {},
                usage: parsed.usage,
                ...parsed.finishReason !== undefined ? { finishReason: parsed.finishReason } : {},
                reasoningChars: parsed.reasoningChars,
            };
        }
        finally {
            if (idleTimer !== undefined)
                clearTimeout(idleTimer);
        }
    }
}
//# sourceMappingURL=backend.js.map