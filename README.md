# dsh-verifier

An LLM-as-a-verifier plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It adds a quality gate that runs at the end of every agent turn, plus three tools the agent can call to check its own work.

The scoring method is a port of [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) by Kwok et al. (project site [llm-as-a-verifier.com](https://llm-as-a-verifier.com/), paper arXiv 2607.05391, MIT). That repo selects the best of N agent trajectories. This plugin takes the same math and wires it into a running harness.

## Why a verifier

The method comes from the llm-as-a-verifier authors. Their framework (source: [llm-as-a-verifier.com](https://llm-as-a-verifier.com/)): probability over the logits instead of a sampled token, a fine-grained scoring token, repetition, and decomposition into simpler criteria, aggregated as R(x, tau) = 1/(C K) sum over criteria, repeats and scale values of p(v | x, c, tau) phi(v).

![LLM-as-a-Verifier framework: uncertainty, granularity, repetition, decomposition](docs/images/llm-as-a-verifier-framework.png)

What that buys with the same model this plugin runs on (chart from the llm-as-a-verifier README; Terminal-Bench 2.1, mini-swe-agent, DeepSeek V4 Flash as generator and verifier, costs at OpenRouter prices of 2026-08-17): best-of-3 lifts DeepSeek V4 Flash from 78.7% to 86.5%, best-of-5 to 88.0%, at roughly a quarter of the cost per task of GPT-5.6 Sol in Codex.

![Terminal-Bench 2.1: success rate against cost per task, DeepSeek V4 Flash with LLM-as-a-Verifier versus Codex and Claude Code](docs/images/terminal-bench-2.1-cost-vs-success.png)

The gate in this plugin is the cheaper cousin of that best-of-N selection: one trajectory, scored once, repaired once. `verifier_select` is the best-of-N itself.

## What it does

**The gate.** When an agent is about to end a turn, the plugin serializes the turn (the task, the assistant messages, every tool call and its observed output) and asks a verifier model to score it per criterion on a 20-letter scale. The score is not the sampled letter. It is the expectation over the logprob distribution of the score token, so the verdict is continuous in [0, 1]. If the mean falls below `gate.threshold`, the verifier's findings go back to the agent as a plugin message and the harness runs another step. The agent sees text like this:

```
[dsh-verifier] Automatic verification of your last turn scored 0.28 / 1.00 (pass threshold 0.60). Round 1 of 1.
Per-criterion rewards: Empirical verification & error signals=0.13, Specification adherence=0.21, Code quality & root cause=0.50.

Verifier findings, Empirical verification & error signals (0.13):
The agent launched three background subagents ... There is zero observed verification in the trajectory: no npm test run, no curl of the service endpoints, no screenshot ...
```

That example is from a real run. The agent answered "Fair criticism, let me check what's actually on disk now instead of trusting narration" and went back to work. Continuations are capped per turn (`gate.maxRounds`, default 1). Turns that end with a question to the user are never forced on.

**The tools.**

| Tool | What it does |
| --- | --- |
| `verifier_assess(task, answer)` | Scores one result per criterion and returns the findings. By default it also hands the verifier the observed trajectory of the current turn, so the verdict rests on tool output rather than on the agent's summary. |
| `verifier_select(task, candidates[])` | Best-of-N. Pairwise comparisons with slot swapping, then a probabilistic pivot tournament picks the winner in N + k(N-k) comparisons instead of N². |
| `verifier_compare(task, a, b)` | One directed pairwise reward. |

**The backend.** `openai-compatible` calls any chat-completions endpoint with `logprobs` and `top_logprobs` (vLLM, SGLang, the DeepSeek API). That is what makes the fine-grained score possible. `harness` routes through the harness LLM seam instead, which carries no logprobs, so scores fall back to the literal letter. Use the direct endpoint when you can.

## What is ported, and where

| Reference concept | File |
| --- | --- |
| 20-letter scale, pairwise orientation (A = best) and progress orientation (T = best) | `src/core/scale.ts` |
| Reward as logprob expectation, last-tag match, fused `>A` tokens, whitespace skip, literal-letter fallback | `src/core/scoring.ts` |
| Criteria × repeats with slot swap on odd repeats; `compare`, `select`, `assess` | `src/core/verifier.ts` |
| Pivot tournament: ring pass, top-k pivots, pivot round, Bradley-Terry argmax | `src/core/tournament.ts` |
| Prompts with the invariant part first and the criterion last (prefix-cache friendly); criteria sets `general`, `coding`, `terminal` | `src/core/prompts.ts` |
| Trajectory serialization from the harness session log | `src/trajectory.ts` |

Things the reference repo does not have: the turn gate (`src/gate.ts`), the tools (`src/tools.ts`), hot-reloadable settings, and the handling of unscored verdicts described below.

## Install

```sh
git clone https://github.com/DevRico003/dsh-verifier
dsh plugin --profile web add /path/to/dsh-verifier
dsh plugin --profile headless add /path/to/dsh-verifier
dsh plugin --profile desktop add /path/to/dsh-verifier    # DSH Desktop
```

`lib/` is committed, so no build step is needed to install. Restart `dsh web` or the desktop app afterwards.

## Configure

Defaults live in `cordis.patch.yml`. The shipped `backend.baseURL` is the placeholder `http://YOUR_SPARK_HOST:8000/v1`; until you set a real endpoint the plugin loads but every verifier call fails with a message naming this setting (the gate then closes turns unverified and logs a warning, `verifier_assess` returns `scoredCriteria: 0` with the message in `findings`). Set at least `backend.baseURL` and `backend.model`. Everything is a hot-reloadable `verifier:` section in `$DSH_HOME/settings.yaml`; no restart.

```yaml
verifier:
  backend:
    kind: openai-compatible        # or: harness
    baseURL: http://YOUR_SPARK_HOST:8000/v1
    model: deepseek-v4-flash-0731
    apiKeyEnv: SPARK_API_KEY       # env var or credential reference; empty = no Authorization header
    reasoningEffort: none          # keep the verifier cheap; none|low|high|max on vLLM
    maxTokens: 4096
    temperature: 1.0               # the reference default; keeps the logprob distribution informative
    topLogprobs: 20
    concurrency: 4
    retriesOnFallback: 1
  gate:
    enabled: true
    threshold: 0.6
    maxRounds: 1
    evaluations: 1                 # repeats per criterion
    criteriaMode: auto             # coding when the turn used tools, else general
    criteria: general
    skipWhenAskingUser: true
    skipSubagents: true            # child agents are not gated; their parent turn is
    minSteps: 1
    feedbackMaxChars: 2500
    timeoutMs: 300000
  select:
    evaluations: 2                 # for the tools; 2 or more cancels slot bias
    pivots: 1
    seed: 0
    criteria: general
  trajectory:
    maxStepChars: 2000
    maxTotalChars: 60000
  tools: true
  verbose: false
```

`gate.enabled: false` keeps the tools and drops the gate. `enabled: false` turns the plugin off.

## Cost

One gate pass is `criteria × evaluations` verifier calls, three by default, fanned out with `backend.concurrency`. On a vLLM server with prefix caching a short turn takes 6 to 10 seconds of wall clock, because the criterion sits at the prompt tail and the rest of the prompt is cached. `verifier_select` with three candidates is 5 pairs × 3 criteria × 2 repeats, about 30 calls.

## Unscored verdicts

A verifier reply sometimes carries no parseable score tag. The plugin retries such a call (`backend.retriesOnFallback`, default 1). What still has no verdict is excluded from every mean and reported as `scored: false`, never counted as a neutral 0.5. A gate pass with zero scored criteria closes the turn unverified and logs it instead of steering the agent on noise.

## Skill

`skills/graph-verified-coding/SKILL.md` is a dsh skill (also usable by Claude Code or Codex from `~/.agents/skills`) that tells the agent how to use the verifier inside a graph-engineered coding process. Seven steps, each with a done-condition: contract (acceptance criteria with observable artifacts), cut false edges (independent nodes in parallel, dependent ones in sequence), work node (keep the proving output), gate (tests, browser loop for rendered output, `verifier_assess` when evidence is ambiguous), join (`verifier_select` over competing candidates), cycle with a stop (repair and re-gate, bounded rounds), report with evidence. A reference block lists the tools and their cost so the agent places gates where they pay: before merges and before the final answer. Link it into a skill root dsh scans:

```sh
ln -s /path/to/dsh-verifier/skills/graph-verified-coding ~/.dsh/skills/graph-verified-coding
```

## Development

Typechecking needs a DeepSeek Harness checkout next to this repo (the `link:` devDependencies point at `../deepseek-harness`). The published `@deepseek-ai/dsh-*` packages on npm are an older generation and do not typecheck against the current harness.

```sh
pnpm install
pnpm run build      # tsc -> lib/
pnpm test           # node:test unit tests
```

## Limitations

- Logprobs need a direct endpoint. `kind: harness` degrades to a 20-level letter judge.
- Score caching exists only inside one `select` call. There is no on-disk cache across calls.
- Criteria sets are built in. Custom criteria files are not loaded yet.
- No custom session events are appended, so session logs stay readable by processes without this plugin. Outcomes are visible through the steered message and the harness logger.

## License

MIT. The scoring method and prompt texts are ported from [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) ([llm-as-a-verifier.com](https://llm-as-a-verifier.com/), MIT); see `LICENSE`. Thank you to the authors for publishing the method, the prompts and the benchmarks.
