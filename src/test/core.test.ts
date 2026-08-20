import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractScore, parseLiteralLetter, analysisBefore } from '../core/scoring.js'
import { pairwiseValue, progressValue, normalizeExpected, GRANULARITY } from '../core/scale.js'
import { bradleyTerry, ringCycle, pivotRoundPairs, pivotTournament, mulberry32, Accumulator, selectPivots } from '../core/tournament.js'
import { buildPairwisePrompt, buildAssessmentPrompt, resolveCriteria } from '../core/prompts.js'
import { assess, compare, select, progress } from '../core/verifier.js'
import { OpenAICompatibleBackend, UnconfiguredBackend, placeholderHost, type VerifierBackend, type CompletionRequest, type Completion } from '../core/backend.js'
import { buildTrajectory, verifierDebt, isChildSession } from '../trajectory.js'
import { checkpointTrigger, renderDebtNudge } from '../checkpoint.js'
import { renderFeedback, skipReason } from '../gate.js'

test('scale values and normalization', () => {
  assert.equal(pairwiseValue('A'), 20)
  assert.equal(pairwiseValue('t'), 1)
  assert.equal(progressValue('A'), 1)
  assert.equal(progressValue('T'), 20)
  assert.equal(pairwiseValue('Z'), undefined)
  assert.equal(normalizeExpected(1), 0)
  assert.equal(normalizeExpected(GRANULARITY), 1)
})

test('extractScore: expectation over logprobs after the LAST tag, ignoring whitespace tokens', () => {
  const text = 'Analysis mentions <score_A> format.\n<score_A> B </score_A>\n<score_B> S </score_B>'
  const tokens = [
    { token: 'Analysis mentions ', logprob: 0, topLogprobs: [] },
    { token: '<score_A>', logprob: 0, topLogprobs: [] },
    { token: ' format.\n', logprob: 0, topLogprobs: [] },
    { token: '<score_A>', logprob: 0, topLogprobs: [] },
    { token: ' ', logprob: 0, topLogprobs: [] },
    { token: 'B', logprob: Math.log(0.5), topLogprobs: [{ token: 'B', logprob: Math.log(0.5) }, { token: 'A', logprob: Math.log(0.5) }, { token: 'x', logprob: Math.log(0.01) }] },
    { token: ' </score_A>\n', logprob: 0, topLogprobs: [] },
    { token: '<score_B>', logprob: 0, topLogprobs: [] },
    { token: ' S', logprob: Math.log(0.9), topLogprobs: [{ token: ' S', logprob: Math.log(0.9) }, { token: ' T', logprob: Math.log(0.1) }] },
    { token: ' </score_B>', logprob: 0, topLogprobs: [] },
  ]
  const a = extractScore(text, tokens, 'score_A', pairwiseValue)
  assert.equal(a.source, 'logprobs')
  // 0.5·20 + 0.5·19 = 19.5 → (19.5-1)/19
  assert.ok(Math.abs(a.score - (18.5 / 19)) < 1e-9, `got ${a.score}`)
  const b = extractScore(text, tokens, 'score_B', pairwiseValue)
  assert.equal(b.source, 'logprobs')
  // 0.9·2 + 0.1·1 = 1.9 → 0.9/19
  assert.ok(Math.abs(b.score - (0.9 / 19)) < 1e-9, `got ${b.score}`)
})

test('extractScore: fused ">A" token and text fallback', () => {
  const text = 'ok\n<score_A>A</score_A>'
  const tokens = [
    { token: 'ok\n<score_A', logprob: 0, topLogprobs: [] },
    { token: '>A', logprob: Math.log(0.7), topLogprobs: [{ token: '>A', logprob: Math.log(0.7) }, { token: '>C', logprob: Math.log(0.3) }] },
    { token: '</score_A>', logprob: 0, topLogprobs: [] },
  ]
  const fused = extractScore(text, tokens, 'score_A', pairwiseValue)
  assert.equal(fused.source, 'logprobs')
  assert.ok(Math.abs(fused.score - ((0.7 * 20 + 0.3 * 18 - 1) / 19)) < 1e-9)
  const textual = extractScore('<score_A> K </score_A>', undefined, 'score_A', pairwiseValue)
  assert.equal(textual.source, 'text')
  assert.equal(textual.letter, 'K')
  const none = extractScore('nothing here', undefined, 'score_A', pairwiseValue)
  assert.equal(none.source, 'fallback')
  assert.equal(none.score, 0.5)
  assert.equal(parseLiteralLetter('<score> q </score>', 'score'), 'Q')
  assert.equal(analysisBefore('why\n<score> A </score>', 'score'), 'why')
})

test('tournament primitives', () => {
  assert.ok(Math.abs(bradleyTerry(0.5, 0.5) - 0.5) < 1e-12)
  assert.ok(bradleyTerry(1, 0) > 0.7)
  const ring = ringCycle(5, mulberry32(0))
  assert.equal(ring.length, 5)
  const asA = new Set(ring.map(p => p[0]))
  const asB = new Set(ring.map(p => p[1]))
  assert.equal(asA.size, 5)
  assert.equal(asB.size, 5)
  assert.deepEqual(ringCycle(2, mulberry32(1)).length, 2)
  assert.deepEqual(pivotRoundPairs(4, [1, 3]), [[0, 1], [0, 3], [2, 1], [2, 3], [1, 3]])
  const acc = new Accumulator(3)
  acc.add(0, 1, 0.9, 0.1)
  acc.add(2, 1, 0.2, 0.8)
  assert.deepEqual(selectPivots(acc, 1), [0])
})

test('pivotTournament picks the dominant candidate with N + k(N-k) comparisons', async () => {
  const quality = [0.2, 0.9, 0.4, 0.6, 0.1]
  let calls = 0
  const result = await pivotTournament(5, 1, 0, async (a, b) => {
    calls++
    return [quality[a]!, quality[b]!] as const
  })
  assert.equal(result.best, 1)
  assert.equal(result.comparisons, 5 + 4)
  assert.equal(calls, 9)
  assert.equal(result.ranking[0], 1)
})

test('prompts keep the criterion at the tail (prefix-cache discipline)', () => {
  const set = resolveCriteria('coding')
  const p1 = buildPairwisePrompt('task', 'A', 'B', set.criteria[0]!, set.groundTruthNote)
  const p2 = buildPairwisePrompt('task', 'A', 'B', set.criteria[1]!, set.groundTruthNote)
  let common = 0
  while (common < p1.length && p1[common] === p2[common]) common++
  assert.ok(common > p1.indexOf('**Rating Scale:**'), 'shared prefix must extend past the rating scale')
  assert.ok(p1.endsWith('Begin your analysis now.'))
  const ap = buildAssessmentPrompt('task', 'trace', set.criteria[2]!, set.groundTruthNote)
  assert.ok(ap.includes('<score> LETTER_A_TO_T </score>'))
  assert.throws(() => resolveCriteria('nope'))
})

/** Scripted backend: answers from the prompt's candidate content. */
function fakeBackend(script: (prompt: string) => string): VerifierBackend {
  return {
    label: 'fake',
    supportsLogprobs: false,
    async complete(request: CompletionRequest): Promise<Completion> {
      return { text: script(request.prompt) }
    },
  }
}

test('compare/select/assess with a text-only backend', async () => {
  // The better candidate contains the word GOOD; the verifier "knows" it.
  const backend = fakeBackend((prompt) => {
    const a = /\*\*Trajectory A:\*\*\n([\s\S]*?)\n\n\*\*Trajectory B:\*\*/.exec(prompt)?.[1] ?? ''
    const b = /\*\*Trajectory B:\*\*\n([\s\S]*?)\n\n\*\*Rating Scale:\*\*/.exec(prompt)?.[1] ?? ''
    if (a !== '' || b !== '') {
      return `analysis\n<score_A> ${a.includes('GOOD') ? 'A' : 'S'} </score_A>\n<score_B> ${b.includes('GOOD') ? 'A' : 'S'} </score_B>`
    }
    const trace = /\*\*Agent trajectory[^\n]*\n([\s\S]*?)\n\nYou will score/.exec(prompt)?.[1] ?? ''
    return `finding: ${trace.includes('GOOD') ? 'fine' : 'missing verification'}\n<score> ${trace.includes('GOOD') ? 'S' : 'C'} </score>`
  })
  const set = resolveCriteria('general')
  const options = { backend, criteria: set.criteria, groundTruthNote: set.groundTruthNote, evaluations: 2, concurrency: 3, maxTokens: 100, temperature: 1, topLogprobs: 20, onError: 'tie' as const }
  const pair = await compare('t', 'bad', 'GOOD answer', options)
  assert.ok(pair.rewardB > pair.rewardA)
  assert.equal(pair.samples.length, set.criteria.length * 2)
  const chosen = await select('t', ['bad', 'worse', 'GOOD answer', 'meh'], { ...options, pivots: 1, seed: 0 })
  assert.equal(chosen.index, 2)
  const good = await assess('t', 'ran tests GOOD', options)
  const bad = await assess('t', 'claims done', options)
  assert.ok(good.score > 0.8 && bad.score < 0.2, `${good.score} ${bad.score}`)
  assert.equal(bad.perCriterion[0]!.analysis, 'finding: missing verification')
})

test('assess retries unparseable replies once and excludes unscored criteria from the mean', async () => {
  let calls = 0
  const backend = fakeBackend((prompt) => {
    calls++
    // Criterion "correctness" never yields a tag; others score T (best).
    if (prompt.includes('Evaluation Guideline for Correctness')) return 'no verdict here'
    return 'fine\n<score> T </score>'
  })
  const set = resolveCriteria('general')
  const options = { backend, criteria: set.criteria, groundTruthNote: set.groundTruthNote, evaluations: 1, concurrency: 3, maxTokens: 100, temperature: 1, topLogprobs: 20, onError: 'tie' as const, retriesOnFallback: 1 }
  const result = await assess('t', 'trace', options)
  assert.equal(calls, 4, 'three criteria plus one retry for the unparseable one')
  assert.equal(result.scoredCriteria, 2)
  assert.equal(result.perCriterion.find(c => c.id === 'correctness')!.scored, false)
  assert.ok(result.score > 0.99, `unscored criterion must not drag the mean to 0.5 (got ${result.score})`)
  const feedback = renderFeedback(result, 0.6, 1, 1, 500)
  assert.ok(feedback.includes('Correctness unscored'))
})

test('buildTrajectory serializes one turn and elides old steps', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 0, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'do X' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 0, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'tool/result', seq: 3, time: 0, data: { turn: 1, step: 1, message: { id: 'r1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] }], source: { kind: 'tool', callId: 'c1' } } } },
    { type: 'assistant/message', seq: 4, time: 0, data: { turn: 1, step: 2, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done: a.txt' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'turn/end', seq: 5, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 6, time: 0, data: { turn: 2 } },
    { type: 'user/message', seq: 7, time: 0, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'other' }], source: { kind: 'user' } } },
  ] as unknown as Parameters<typeof buildTrajectory>[0]
  const trajectory = buildTrajectory(events, 1, { maxStepChars: 2000, maxTotalChars: 60000 })
  assert.equal(trajectory.task, 'do X')
  assert.equal(trajectory.steps, 2)
  assert.equal(trajectory.toolCalls, 1)
  assert.equal(trajectory.finalText, 'done: a.txt')
  assert.equal(trajectory.lastToolName, 'bash')
  assert.ok(trajectory.trace.includes('[Tool call] bash'))
  assert.ok(trajectory.trace.includes('[Output] a.txt'))
  assert.ok(!trajectory.trace.includes('other'))
  const tiny = buildTrajectory(events, 1, { maxStepChars: 2000, maxTotalChars: 60 })
  assert.ok(tiny.trace.startsWith('(1 earlier step(s) elided)'))
  assert.equal(skipReason({ ...trajectory, finalText: 'Which file?' }, { enabled: true, threshold: 0.6, maxRounds: 1, evaluations: 1, criteria: 'general', criteriaMode: 'auto', skipWhenAskingUser: true, minSteps: 1, skipSubagents: true, handoffTools: ['ask_user'], feedbackMaxChars: 100, timeoutMs: 1000 }), 'final message asks the user a question')
  const feedback = renderFeedback({ score: 0.3, scoredCriteria: 1, perCriterion: [{ id: 'c', name: 'Correctness', score: 0.3, analysis: 'wrong sum', source: 'text', scored: true }] }, 0.6, 1, 1, 100)
  assert.ok(feedback.includes('wrong sum') && feedback.includes('0.30'))
})

test('placeholder hosts are detected and the stand-in backend explains the fix in the findings', async () => {
  assert.equal(placeholderHost('http://YOUR_SPARK_HOST:8000/v1'), 'YOUR_SPARK_HOST')
  assert.equal(placeholderHost('http://192.168.178.60:8000/v1'), undefined)
  assert.equal(placeholderHost('https://api.deepseek.com/v1'), undefined)
  const backend = new UnconfiguredBackend('http://YOUR_SPARK_HOST:8000/v1', 'YOUR_SPARK_HOST')
  const set = resolveCriteria('general')
  const options = { backend, criteria: set.criteria, groundTruthNote: set.groundTruthNote, evaluations: 1, concurrency: 3, maxTokens: 100, temperature: 1, topLogprobs: 20, onError: 'tie' as const, retriesOnFallback: 0 }
  const result = await assess('t', 'trace', options)
  assert.equal(result.scoredCriteria, 0)
  assert.ok(result.perCriterion[0]!.analysis.includes('set verifier.backend.baseURL'), result.perCriterion[0]!.analysis)
})

test('extractScore: reasoning tokens before the tag (vLLM thinking) and split tag tokens', () => {
  // Token stream = reasoning + answer, as vLLM returns logprobs with thinking on; `text` is the answer only.
  const text = '<score> C </score>'
  const mk = (token: string, alts: [string, number][] = []): { token: string; logprob: number; topLogprobs: { token: string; logprob: number }[] } =>
    ({ token, logprob: Math.log(0.9), topLogprobs: alts.map(([t, p]) => ({ token: t, logprob: Math.log(p) })) })
  const tokens = [
    mk('We'), mk(' think'), mk(' about'), mk(' <'), mk('score'), mk('>'), mk(' later'), mk('.'),
    mk('<'), mk('score'), mk('>'), mk(' C', [[' C', 0.6], [' D', 0.3], ['C', 0.1]]), mk(' </'), mk('score'), mk('>'),
  ]
  const result = extractScore(text, tokens, 'score', progressValue)
  assert.equal(result.source, 'logprobs')
  // mass: C = max(0.6 alt, 0.1 alt, 0.9 own) = 0.9 (value 3), D = 0.3 (value 4) -> expected (0.9*3+0.3*4)/1.2 = 3.25 -> (3.25-1)/19
  assert.ok(Math.abs(result.score - ((0.9 * 3 + 0.3 * 4) / 1.2 - 1) / 19) < 1e-9, String(result.score))
})

test('runWarm: the first call of a prefix finishes before the rest start', async () => {
  const order: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const backend: VerifierBackend = {
    label: 'fake', supportsLogprobs: false,
    async complete(request: CompletionRequest): Promise<Completion> {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      order.push(request.prompt.includes('Evaluation Guideline for Correctness') ? 'correctness' : 'other')
      await new Promise(resolve => setTimeout(resolve, 20))
      inFlight--
      return { text: 'ok\n<score> T </score>' }
    },
  }
  const set = resolveCriteria('general')
  const options = { backend, criteria: set.criteria, groundTruthNote: set.groundTruthNote, evaluations: 1, concurrency: 4, maxTokens: 100, temperature: 1, topLogprobs: 20, onError: 'tie' as const, retriesOnFallback: 0, warmPrefix: true }
  const result = await assess('t', 'trace', options)
  assert.equal(result.scoredCriteria, 3)
  assert.equal(order[0], 'correctness')
  assert.ok(maxInFlight <= 2, `warm-up must run alone first, saw ${maxInFlight} in flight`)
})

test('OpenAICompatibleBackend fails loud when the reply has reasoning but no answer', async () => {
  const backend = new OpenAICompatibleBackend({
    baseURL: 'http://example.invalid/v1', model: 'm', timeoutMs: 1000, reasoningEffort: 'high',
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: null, reasoning: 'x'.repeat(50) }, finish_reason: 'length' }] }), { status: 200 })) as typeof fetch,
  })
  await assert.rejects(() => backend.complete({ prompt: 'p', maxTokens: 10, temperature: 1, logprobs: true, topLogprobs: 20 }), /no answer text.*finish_reason=length/)
})

test('progress(): reference progress prompt, one checkpoint, letter read from the c1 tag', async () => {
  const seen: string[] = []
  const backend = fakeBackend((prompt) => { seen.push(prompt); return '<c1>R</c1>' })
  const result = await progress('task', '--- Agent Step 1 ---\n[Output] ok', 1, { backend, evaluations: 2, concurrency: 2, maxTokens: 50, temperature: 1, topLogprobs: 20 })
  assert.equal(result.scoredRepeats, 2)
  assert.ok(Math.abs(result.score - 17 / 19) < 1e-9, String(result.score))
  assert.ok(seen[0]!.includes('You will score the trajectory at 1 CHECKPOINTS'))
  assert.ok(seen[0]!.includes('Checkpoint 1 = state right after Agent Step 1'))
  assert.ok(seen[0]!.includes('Trust observed output — NOT the agent\'s narration.'))
})

test('checkpointTrigger and verifierDebt', () => {
  assert.equal(checkpointTrigger(0.2, undefined, 0.3, 0.25)?.startsWith('progress 0.20 below'), true)
  assert.equal(checkpointTrigger(0.5, 0.8, 0.3, 0.25)?.startsWith('progress fell'), true)
  assert.equal(checkpointTrigger(0.6, 0.7, 0.3, 0.25), undefined)
  const call = (name: string): { type: 'tool-call'; id: string; name: string; arguments: string } => ({ type: 'tool-call', id: name, name, arguments: '{}' })
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [call('write'), call('edit')] } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [call('verifier_assess')] } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [call('edit'), call('bash'), call('edit')] } } },
  ] as unknown as Parameters<typeof verifierDebt>[0]
  const debt = verifierDebt(events, 1, ['write', 'edit'])
  assert.deepEqual(debt, { edits: 2, lastVerifierStep: 2 })
  const nudge = renderDebtNudge(12)
  assert.ok(nudge.includes('verifier_assess'))
})

test('criteria sets carry the reference wording', () => {
  const coding = resolveCriteria('coding')
  assert.deepEqual(coding.criteria.map(c => c.id), ['specification', 'code_review', 'verification'])
  assert.ok(coding.criteria[1]!.description.startsWith('Review the agent\'s final patch (`diff --git ...`) as an experienced code reviewer would.'))
  const terminal = resolveCriteria('terminal')
  assert.ok(terminal.criteria[1]!.description.startsWith('Find the FINAL verification command the agent ran'))
})

test('goal rounds count as the task; child sessions are recognised by header fields or descriptor event', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 }, content: [{ type: 'text', text: '<goal_round> Objective: build it' }] } },
    { type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '<system-reminder> rules' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
  ] as unknown as Parameters<typeof buildTrajectory>[0]
  const trajectory = buildTrajectory(events, 1, { maxStepChars: 1000, maxTotalChars: 10000 })
  assert.ok(trajectory.task.startsWith('<goal_round> Objective'))
  assert.ok(trajectory.trace.includes('[Harness context injected during the turn]'))
  assert.equal(isChildSession({ events: [] }), false)
  assert.equal(isChildSession({ meta: { parentSession: 'p' }, events: [] }), true)
  assert.equal(isChildSession({ origin: 'subagent', events: [] }), true)
  assert.equal(isChildSession({ events: [{ type: 'subagent/descriptor', data: {} }] as unknown as Parameters<typeof isChildSession>[0]['events'] }), true)
})

test('a later turn that opens with "Continue." carries the goal objective forward as its task', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 }, content: [{ type: 'text', text: '<goal_round> Objective: build the app' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
  ] as unknown as Parameters<typeof buildTrajectory>[0]
  const t2 = buildTrajectory(events, 2, { maxStepChars: 1000, maxTotalChars: 10000 })
  assert.ok(t2.task.startsWith('Goal objective (set in an earlier turn):\n<goal_round> Objective: build the app'))
  assert.ok(t2.task.endsWith('Continue.'))
  const t1 = buildTrajectory(events, 1, { maxStepChars: 1000, maxTotalChars: 10000 })
  assert.equal(t1.task, '<goal_round> Objective: build the app')
})
