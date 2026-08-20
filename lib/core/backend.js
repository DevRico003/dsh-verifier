/**
 * Verifier model backends.
 *
 * - `OpenAICompatibleBackend`: direct chat-completions call with
 *   `logprobs` + `top_logprobs`, which is what makes the fine-grained
 *   expectation score possible (vLLM / SGLang / DeepSeek API all serve it).
 * - `HarnessLlmBackend`: routes through the harness `ctx.llm` seam (any
 *   configured provider), text-only, so scores degrade to the literal letter.
 */
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
        this.reason = `dsh-verifier: backend.baseURL still holds the placeholder "${host}"; set verifier.backend.baseURL (and model) in $DSH_HOME/settings.yaml to your OpenAI-compatible endpoint`;
    }
    complete() {
        return Promise.reject(new Error(this.reason));
    }
}
function composeSignal(a, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return a === undefined ? timeout : AbortSignal.any([a, timeout]);
}
export class OpenAICompatibleBackend {
    options;
    label;
    supportsLogprobs = true;
    constructor(options) {
        this.options = options;
        this.label = `${options.baseURL} · ${options.model}`;
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
            ...options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {},
            ...options.extraBody ?? {},
        };
        const headers = { 'content-type': 'application/json' };
        if (options.apiKey !== undefined && options.apiKey !== '')
            headers['authorization'] = `Bearer ${options.apiKey}`;
        const doFetch = options.fetchImpl ?? fetch;
        const response = await doFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: composeSignal(request.signal, options.timeoutMs),
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(`dsh-verifier: backend ${this.label} answered HTTP ${response.status}: ${payload.error?.message ?? 'unknown error'}`);
        }
        const choice = payload.choices?.[0];
        if (choice === undefined)
            throw new Error(`dsh-verifier: backend ${this.label} returned no choices`);
        const text = choice.message?.content ?? '';
        const tokens = choice.logprobs?.content?.map(entry => ({
            token: entry.token,
            logprob: entry.logprob,
            topLogprobs: (entry.top_logprobs ?? []).map(alt => ({ token: alt.token, logprob: alt.logprob })),
        }));
        return {
            text,
            ...tokens !== undefined && tokens.length > 0 ? { tokens } : {},
            usage: {
                promptTokens: payload.usage?.prompt_tokens,
                completionTokens: payload.usage?.completion_tokens,
                cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
            },
        };
    }
}
export class HarnessLlmBackend {
    llm;
    options;
    label;
    supportsLogprobs = false;
    constructor(llm, options) {
        this.llm = llm;
        this.options = options;
        this.label = `harness:${options.provider} · ${options.model}`;
    }
    async complete(request) {
        const { options } = this;
        const text = await options.collectText(this.llm.stream({
            provider: options.provider,
            model: options.model,
            ...options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {},
            messages: [options.createUserMessage(request.prompt)],
            ...request.system !== undefined ? { system: request.system } : {},
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            signal: composeSignal(request.signal, options.timeoutMs),
        }));
        return { text };
    }
}
//# sourceMappingURL=backend.js.map