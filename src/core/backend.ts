/**
 * Verifier model backends.
 *
 * `OpenAICompatibleBackend` makes a direct chat-completions call with
 * `logprobs` + `top_logprobs`, which is what makes the fine-grained
 * expectation score possible (vLLM / SGLang / DeepSeek API all serve it).
 */

import { Agent as UndiciAgent } from 'undici'
import type { TokenLogprob } from './scoring.js'

export interface CompletionRequest {
  prompt: string
  system?: string
  /** Per-call `reasoning_effort`; overrides the backend default when set. */
  reasoningEffort?: string
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
  /** `finish_reason` of the reply when the backend reports one. */
  finishReason?: string
  /** Size of the reasoning the backend returned beside the answer (0 when none). */
  reasoningChars?: number
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
    this.reason = `dsh-verifier-gate: backend.baseURL still holds the placeholder "${host}"; set verifier.backend.baseURL (and model) in $DSH_HOME/settings.yaml to your OpenAI-compatible endpoint`
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
  /** Hard cap per call. */
  timeoutMs: number
  /** Abort when no token arrives for this long (streaming keeps the connection alive while the model thinks). */
  idleTimeoutMs?: number
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


interface ParsedCompletion {
  text: string
  tokens: TokenLogprob[]
  finishReason?: string
  reasoningChars: number
  usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number }
}

function mapLogprobs(entries: { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] }[] | null | undefined): TokenLogprob[] {
  return (entries ?? []).map(entry => ({
    token: entry.token,
    logprob: entry.logprob,
    topLogprobs: (entry.top_logprobs ?? []).map(alt => ({ token: alt.token, logprob: alt.logprob })),
  }))
}

function fromJson(payload: ChatCompletionResponse): ParsedCompletion {
  const choice = payload.choices?.[0]
  if (choice === undefined) throw new Error('dsh-verifier-gate: backend returned no choices')
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
  }
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; logprobs?: { content?: { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] }[] | null } | null; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null
  error?: { message?: string }
}

/** Parse an OpenAI-style SSE stream; `onChunk` runs for every chunk (the idle timer's heartbeat). */
export async function readEventStream(body: ReadableStream<Uint8Array>, onChunk: () => void): Promise<ParsedCompletion> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let text = ''
  let reasoningChars = 0
  let finishReason: string | undefined
  const tokens: TokenLogprob[] = []
  let usage: ParsedCompletion['usage'] = {}
  const handle = (line: string): void => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') return
    let chunk: StreamChunk
    try {
      chunk = JSON.parse(data) as StreamChunk
    } catch {
      return
    }
    if (chunk.error !== undefined) throw new Error(`dsh-verifier-gate: backend stream error: ${chunk.error.message ?? 'unknown'}`)
    const choice = chunk.choices?.[0]
    if (choice !== undefined) {
      if (choice.delta?.content) text += choice.delta.content
      reasoningChars += (choice.delta?.reasoning ?? choice.delta?.reasoning_content ?? '').length
      tokens.push(...mapLogprobs(choice.logprobs?.content))
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
    if (chunk.usage) {
      usage = {
        ...chunk.usage.prompt_tokens !== undefined ? { promptTokens: chunk.usage.prompt_tokens } : {},
        ...chunk.usage.completion_tokens !== undefined ? { completionTokens: chunk.usage.completion_tokens } : {},
        ...chunk.usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens } : {},
      }
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onChunk()
    buffer += decoder.decode(value, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      handle(line)
    }
  }
  if (buffer.trim() !== '') handle(buffer)
  return { text, tokens, ...finishReason !== undefined ? { finishReason } : {}, reasoningChars, usage }
}

export class OpenAICompatibleBackend implements VerifierBackend {
  readonly label: string
  readonly supportsLogprobs = true
  /** Node's global fetch gives up on response headers after 300 s; a thinking verifier on a long trajectory can take longer, so the dispatcher follows `timeoutMs`. */
  private readonly dispatcher: UndiciAgent
  constructor(private readonly options: OpenAICompatibleOptions) {
    this.label = `${options.baseURL} · ${options.model}`
    this.dispatcher = new UndiciAgent({ headersTimeout: options.timeoutMs, bodyTimeout: options.timeoutMs })
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
      ...(request.reasoningEffort ?? options.reasoningEffort) !== undefined ? { reasoning_effort: request.reasoningEffort ?? options.reasoningEffort } : {},
      // Stream so a long think never trips a header timeout; the idle timer below guards a stalled stream.
      stream: true,
      stream_options: { include_usage: true },
      ...options.extraBody ?? {},
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.apiKey !== undefined && options.apiKey !== '') headers['authorization'] = `Bearer ${options.apiKey}`
    const doFetch = options.fetchImpl ?? fetch
    const idle = new AbortController()
    const idleMs = options.idleTimeoutMs ?? 300_000
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => idle.abort(new Error(`dsh-verifier-gate: backend ${this.label} sent nothing for ${idleMs} ms`)), idleMs)
    }
    armIdle()
    let response: Response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([composeSignal(request.signal, options.timeoutMs), idle.signal]),
        ...options.fetchImpl === undefined ? { dispatcher: this.dispatcher } : {},
      } as RequestInit)
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as ChatCompletionResponse
        throw new Error(`dsh-verifier-gate: backend ${this.label} answered HTTP ${response.status}: ${payload.error?.message ?? 'unknown error'}`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      const parsed = contentType.includes('text/event-stream') && response.body !== null
        ? await readEventStream(response.body, armIdle)
        : fromJson(await response.json() as ChatCompletionResponse)
      if (parsed.text.trim() === '') {
        // With thinking on, a reply that ran out of tokens carries reasoning but no answer, so there is no score to read.
        throw new Error(`dsh-verifier-gate: backend ${this.label} returned no answer text (finish_reason=${parsed.finishReason ?? 'unknown'}, reasoning chars=${parsed.reasoningChars}); raise backend.maxTokens or lower backend.reasoningEffort`)
      }
      return {
        text: parsed.text,
        ...parsed.tokens.length > 0 ? { tokens: parsed.tokens } : {},
        usage: parsed.usage,
        ...parsed.finishReason !== undefined ? { finishReason: parsed.finishReason } : {},
        reasoningChars: parsed.reasoningChars,
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
    }
  }
}
