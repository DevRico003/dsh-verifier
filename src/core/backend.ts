/**
 * Verifier model backends.
 *
 * - `OpenAICompatibleBackend`: direct chat-completions call with
 *   `logprobs` + `top_logprobs`, which is what makes the fine-grained
 *   expectation score possible (vLLM / SGLang / DeepSeek API all serve it).
 * - `HarnessLlmBackend`: routes through the harness `ctx.llm` seam (any
 *   configured provider), text-only, so scores degrade to the literal letter.
 */

import type { TokenLogprob } from './scoring.js'

export interface CompletionRequest {
  prompt: string
  system?: string
  maxTokens: number
  temperature: number
  /** Request token logprobs (ignored by backends that cannot serve them). */
  logprobs: boolean
  topLogprobs: number
  signal?: AbortSignal
}

export interface Completion {
  text: string
  tokens?: TokenLogprob[]
  usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number }
}

export interface VerifierBackend {
  /** Human-readable route description for logs. */
  readonly label: string
  /** Whether this backend can return token logprobs. */
  readonly supportsLogprobs: boolean
  complete(request: CompletionRequest): Promise<Completion>
}

/** Hosts like `YOUR_SPARK_HOST` that a checkout ships instead of a real endpoint. */
export function placeholderHost(baseURL: string): string | undefined {
  // Raw match: `new URL()` lowercases hostnames and would hide the placeholder's spelling.
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?\[?([^\]/:?#]+)/i.exec(baseURL)?.[1]
  if (host === undefined) return undefined
  return /^YOUR_|_HOST$|^<.*>$|^example\.(com|org|net)$/i.test(host) ? host : undefined
}

/**
 * Backend standing in while `backend.baseURL` still holds a placeholder: every
 * call fails with the fix spelled out, so the gate warns and the tools tell the
 * agent what to report instead of a bare DNS error.
 */
export class UnconfiguredBackend implements VerifierBackend {
  readonly label: string
  readonly supportsLogprobs = false
  readonly reason: string
  constructor(baseURL: string, host: string) {
    this.label = `${baseURL} (unconfigured)`
    this.reason = `dsh-verifier: backend.baseURL still holds the placeholder "${host}"; set verifier.backend.baseURL (and model) in $DSH_HOME/settings.yaml to your OpenAI-compatible endpoint`
  }

  complete(): Promise<Completion> {
    return Promise.reject(new Error(this.reason))
  }
}

export interface OpenAICompatibleOptions {
  baseURL: string
  model: string
  apiKey?: string
  /** Sent as `reasoning_effort` when set (vLLM accepts none|low|high|max for DeepSeek V4). */
  reasoningEffort?: string
  /** Extra request fields merged into the JSON body (e.g. `chat_template_kwargs`). */
  extraBody?: Record<string, unknown>
  timeoutMs: number
  fetchImpl?: typeof fetch
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }
    logprobs?: { content?: { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] }[] | null } | null
    finish_reason?: string
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string }
}

function composeSignal(a: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return a === undefined ? timeout : AbortSignal.any([a, timeout])
}

export class OpenAICompatibleBackend implements VerifierBackend {
  readonly label: string
  readonly supportsLogprobs = true
  constructor(private readonly options: OpenAICompatibleOptions) {
    this.label = `${options.baseURL} · ${options.model}`
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const { options } = this
    const url = `${options.baseURL.replace(/\/+$/, '')}/chat/completions`
    const messages: { role: string; content: string }[] = []
    if (request.system !== undefined && request.system !== '') messages.push({ role: 'system', content: request.system })
    messages.push({ role: 'user', content: request.prompt })
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      ...request.logprobs ? { logprobs: true, top_logprobs: request.topLogprobs } : {},
      ...options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {},
      ...options.extraBody ?? {},
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.apiKey !== undefined && options.apiKey !== '') headers['authorization'] = `Bearer ${options.apiKey}`
    const doFetch = options.fetchImpl ?? fetch
    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: composeSignal(request.signal, options.timeoutMs),
    })
    const payload = await response.json() as ChatCompletionResponse
    if (!response.ok) {
      throw new Error(`dsh-verifier: backend ${this.label} answered HTTP ${response.status}: ${payload.error?.message ?? 'unknown error'}`)
    }
    const choice = payload.choices?.[0]
    if (choice === undefined) throw new Error(`dsh-verifier: backend ${this.label} returned no choices`)
    const text = choice.message?.content ?? ''
    const tokens = choice.logprobs?.content?.map(entry => ({
      token: entry.token,
      logprob: entry.logprob,
      topLogprobs: (entry.top_logprobs ?? []).map(alt => ({ token: alt.token, logprob: alt.logprob })),
    }))
    return {
      text,
      ...tokens !== undefined && tokens.length > 0 ? { tokens } : {},
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
        cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
      },
    }
  }
}

/** Minimal view of the harness LLM seam this backend needs (kept structural to avoid a hard type dependency). */
export interface HarnessLlmLike {
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: string
    messages: unknown[]
    system?: string
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<unknown>
}

export interface HarnessLlmBackendOptions {
  provider: string
  model: string
  reasoningEffort?: string
  timeoutMs: number
  createUserMessage: (text: string) => unknown
  collectText: (chunks: AsyncIterable<unknown>) => Promise<string>
}

export class HarnessLlmBackend implements VerifierBackend {
  readonly label: string
  readonly supportsLogprobs = false
  constructor(private readonly llm: HarnessLlmLike, private readonly options: HarnessLlmBackendOptions) {
    this.label = `harness:${options.provider} · ${options.model}`
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const { options } = this
    const text = await options.collectText(this.llm.stream({
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {},
      messages: [options.createUserMessage(request.prompt)],
      ...request.system !== undefined ? { system: request.system } : {},
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      signal: composeSignal(request.signal, options.timeoutMs),
    }))
    return { text }
  }
}
