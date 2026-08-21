# dsh-verifier-gate

An LLM-as-a-verifier plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It adds a quality gate that runs at the end of every agent turn, plus three tools the agent can call to check its own work.

The scoring method is a port of [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) by Kwok et al. (project site [llm-as-a-verifier.com](https://llm-as-a-verifier.com/), paper arXiv 2607.05391, MIT). That repo selects the best of N agent trajectories. This plugin takes the same math and wires it into a running harness.

## How it fits together

Two pictures. The first is the plugin inside one agent turn: where it reads, where it speaks, and what it costs. The second is the skill `graph-verified-coding`, the working method that decides when the agent calls the tools.

```mermaid
flowchart TD
    subgraph turn["One agent turn in dsh"]
        S["agent steps 1..n<br/>read, edit, bash, browser, tests"]
        S -->|"every 40 steps"| P["progress reading<br/>low, one call, background<br/>A..T letter"]
        P -->|"fell by 0.25, or stalled<br/>twice under 0.30"| A["assessment with findings<br/>three calls, the step waits"]
        A -->|"[dsh-verifier-gate checkpoint]<br/>into the same step"| S
        S -->|"12 file edits without<br/>a verifier call"| D["reminder, no model call<br/>[dsh-verifier-gate] 12 edits since..."]
        D --> S
        S -->|"the agent calls verifier_assess,<br/>verifier_select, verifier_compare"| T["tool verdict<br/>score, pass, findings"]
        T --> S
        S --> E{"turn stopping"}
    end
    E -->|"gate: three calls at high over the<br/>whole turn plus the goal objective"| G{"score ≥ 0.6 ?"}
    G -->|"yes"| C["turn closes"]
    G -->|"no, once"| R["[dsh-verifier-gate] findings<br/>the agent repairs, then the turn closes"]
    R --> S
    subgraph backend["verifier backend"]
        V["same model, OpenAI-compatible<br/>streamed, logprobs top 20<br/>score = expectation over the letter distribution"]
    end
    P -.-> V
    A -.-> V
    T -.-> V
    E -.-> V
```

```mermaid
flowchart TD
    C["1 Contract<br/>acceptance criteria with an observable artifact each"] --> K["2 Cut false edges<br/>nodes; parallel only where no output flows<br/>children write .graph/&lt;node&gt;.md"]
    K --> W["3 Work node<br/>implement, run the proving command, keep the output"]
    W --> G["4 Gate<br/>tests, lint, build<br/>ui_snapshot + analyze_image for anything rendered<br/>verifier_assess(criteria coding) with contract + evidence"]
    G -->|"pass"| J{"competing candidates?"}
    G -->|"fail"| Y["6 Cycle with a stop<br/>repair, re-gate, two rounds, then report what is open"]
    Y --> G
    J -->|"yes"| V["5 Join<br/>verifier_select / verifier_compare<br/>merge the winner, gate the merge"]
    J -->|"no"| N{"more nodes?"}
    V --> N
    N -->|"yes"| W
    N -->|"no"| R["7 Report with evidence<br/>commands, tests, snapshots, every verifier call with score"]
    R --> Z["turn ends: the plugin gate scores the whole turn"]
```

## Why a verifier

The method comes from the llm-as-a-verifier authors. Their framework (source: [llm-as-a-verifier.com](https://llm-as-a-verifier.com/)): probability over the logits instead of a sampled token, a fine-grained scoring token, repetition, and decomposition into simpler criteria, aggregated as R(x, tau) = 1/(C K) sum over criteria, repeats and scale values of p(v | x, c, tau) phi(v).

![LLM-as-a-Verifier framework: uncertainty, granularity, repetition, decomposition](docs/images/llm-as-a-verifier-framework.png)

What that buys with the same model this plugin runs on (chart from the llm-as-a-verifier README; Terminal-Bench 2.1, mini-swe-agent, DeepSeek V4 Flash as generator and verifier, costs at OpenRouter prices of 2026-08-17): best-of-3 lifts DeepSeek V4 Flash from 78.7% to 86.5%, best-of-5 to 88.0%, at roughly a quarter of the cost per task of GPT-5.6 Sol in Codex.

![Terminal-Bench 2.1: success rate against cost per task, DeepSeek V4 Flash with LLM-as-a-Verifier versus Codex and Claude Code](docs/images/terminal-bench-2.1-cost-vs-success.png)

The gate in this plugin is the cheaper cousin of that best-of-N selection: one trajectory, scored once, repaired once. `verifier_select` is the best-of-N itself.

## What it does

**The gate.** When an agent is about to end a turn, the plugin serializes the turn (the task, the assistant messages, every tool call and its observed output) and asks a verifier model to score it per criterion on a 20-letter scale. The score is not the sampled letter. It is the expectation over the logprob distribution of the score token, so the verdict is continuous in [0, 1]. If the mean falls below `gate.threshold`, the verifier's findings go back to the agent as a plugin message and the harness runs another step. The agent sees text like this:

```
[dsh-verifier-gate] Automatic verification of your last turn scored 0.28 / 1.00 (pass threshold 0.60). Round 1 of 1.
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
| `ui_snapshot(url)` | Evidence for visual work: headless screenshots of one URL across viewports (default 1440x900 and 390x844) in light and dark mode, written as PNGs under `$DSH_HOME/verifier/snapshots/<label>/`, plus the console errors, page errors and failed requests seen while loading. Runs Playwright against the installed Google Chrome (then Playwright's Chromium); nothing opens on screen. Pair it with a vision tool such as `analyze_image` for the verdict. |

**The backend.** `openai-compatible` calls any chat-completions endpoint with `logprobs` and `top_logprobs` (vLLM, SGLang, the DeepSeek API). That is what makes the fine-grained score possible. `harness` routes through the harness LLM seam instead, which carries no logprobs, so scores fall back to the literal letter. Use the direct endpoint when you can.

## Prompts

The verifier-facing text is the reference's. The pairwise prompt (`build_prompt`), the progress prompt (`build_progress_prompt`, one checkpoint), the two scale descriptions and the ground-truth notes are verbatim. The `coding` criteria are `specification` from `criteria/terminal_bench.md` plus `code_review` and `verification` from `criteria/swe_bench.md` ("issue" read as "task", and the patch defined as diff output or the file contents written through tools, because a harness trajectory carries edits as tool calls); `terminal` is `criteria/terminal_bench.md`; `general` is this plugin's own set for prose and answers. The single-trajectory assessment prompt behind `verifier_assess` and the gate is the progress prompt reduced to the final state and extended with one criterion guideline and a request to name what is missing, because that analysis is what the agent gets back. The agent-facing texts (tool descriptions, gate and checkpoint messages) are this plugin's own.

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
git clone https://github.com/DevRico003/dsh-verifier-gate
dsh plugin --profile web add /path/to/dsh-verifier-gate
dsh plugin --profile headless add /path/to/dsh-verifier-gate
dsh plugin --profile desktop add /path/to/dsh-verifier-gate    # DSH Desktop
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
    reasoningEffort: high          # the reference setting; low is ~3x faster with close verdicts, none is a one-shot reading
    maxTokens: 65536               # reasoning shares the budget; room so a long think still ends in an answer
    temperature: 1.0               # the reference default; keeps the logprob distribution informative
    topLogprobs: 20
    concurrency: 4
    retriesOnFallback: 1
    warmPrefix: false              # true = first call per prompt prefix alone, then the rest (saves prefill, doubles wall-clock)
    toolReasoningEffort: ""       # effort for the verifier_* tools; empty = reasoningEffort
    timeoutMs: 3600000             # last-resort cap per call
    idleTimeoutMs: 900000          # abort when the stream delivers nothing for this long (a queued request is silent until scheduled)
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
    minToolCallsWithoutOwnTask: 8  # a turn opened only by a subagent report or notice is gated only with real work in it
    feedbackMaxChars: 2500
    timeoutMs: 4200000
  select:
    evaluations: 2                 # for the tools; 2 or more cancels slot bias
    pivots: 1
    seed: 0
    criteria: general
  trajectory:
    maxStepChars: 6000             # per tool output / message excerpt
    maxTotalChars: 300000          # whole turn; oldest steps are elided first
    continuationTurns: 1           # a turn opening with "Continue." gets this many earlier turns prepended
    toolMaxTotalChars: 80000       # trajectory cap for the verifier_* tools
  checkpoint:
    enabled: true                  # mid-turn verification, see below
    minSteps: 40
    everySteps: 40
    evaluations: 1
    threshold: 0.3                 # steer when progress is below this
    drop: 0.25                     # or fell by this much since the last checkpoint
    minRise: 0.05                  # below threshold and rising less than this = stalled
    stallReadings: 2               # consecutive stalled readings before a steer; a fall steers at once
    maxSteers: 3                   # per turn
    deliver: blocking              # assess a triggered checkpoint while the agent waits (fresh findings); background = asynchronous
    reasoningEffort: low           # checkpoints think at low (frequent, and they block when triggered); gate and tools keep backend.reasoningEffort
    gateDebtEdits: 12              # remind after this many file edits without a verifier_* call (0 = off)
    editTools: [write, edit, str_replace_editor, apply_patch, notebook_edit]
    timeoutMs: 3600000
  snapshot:
    enabled: true                  # the ui_snapshot tool
    channels: [chrome, chromium]   # tried in order; chrome = installed Google Chrome
    headless: true
    viewports: ["1440x900", "390x844"]
    settleMs: 500
    navigationTimeoutMs: 30000
    dir: ""                        # empty = $DSH_HOME/verifier/snapshots
  tools: true
  verbose: false
```

`gate.enabled: false` keeps the tools and drops the gate. `enabled: false` turns the plugin off.

## One long turn

An unattended coding run is often a single turn of several hundred steps, and an end-of-turn gate verifies that turn once, at the end. Two mechanisms make one turn verifiable while it runs, both hooked into `agent/pre-step`:

**Progress checkpoints.** Every `checkpoint.everySteps` steps (from `minSteps` on) the turn so far is scored with the reference progress prompt, verbatim, one checkpoint (the current state), letter only, `evaluations` repeats. That is the reference's `ProgressTracker.update`. Checkpoints think at `checkpoint.reasoningEffort` (`low` by default): they run often and block the agent when they trigger, and `low` gave verdicts within 0.06 of `high` on this setup at a third of the time; the end-of-turn gate and the tools keep `backend.reasoningEffort`. The progress reading runs in the background; the agent keeps working. When a reading triggers, the assessment with findings runs at the next step boundary while the agent waits (`deliver: blocking`), so the findings describe the state the agent is in when it reads them instead of a state several minutes old; `background` keeps the old asynchronous steer. The first checkpoint sets the baseline (a long goal reads low early, by design). From the second on, a fall by `drop`, or `stallReadings` consecutive readings below `threshold` that did not rise by `minRise` (the reference's regression and plateau patterns), gets the turn assessed with findings, and the agent receives a `[dsh-verifier-gate checkpoint]` message at its next step boundary, capped at `maxSteers` per turn. A run that keeps climbing costs one cheap call per checkpoint and no steer.

**Gate debt.** When the agent has made `gateDebtEdits` file edits since its last `verifier_*` call, it receives one reminder to gate the node (no model call). The `graph-verified-coding` skill asks for one `verifier_assess` per completed multi-file node; this is what catches an agent that forgot.

Turn ends still get the full gate. A goal that runs in phases (one turn per phase) gets a gate per phase on top. Some hosts open a new turn for every subagent report; such a turn usually holds an acknowledgement and nothing else, and judging it against the goal would fail it for everything the goal still lacks, so a turn without its own task message is gated only when it made at least `gate.minToolCallsWithoutOwnTask` tool calls. A turn that opens with "Continue." (auto-continue after an interruption, a resumed goal round) holds little of the work, so the trajectory handed to the verifier prepends the previous turn (`trajectory.continuationTurns`); otherwise a gate right after a restart would see commands but no code.

## Cost

One gate pass is `criteria × evaluations` verifier calls, three by default, fanned out together. `warmPrefix: true` runs the first call alone so the server caches the prompt prefix (task, trajectory, scale; the criterion sits at the tail) before the rest go out; that is the reference's 3.4× saving in uncached input tokens, worth it on a priced API or a slow prefill. On a local vLLM that prefills at over 10k tokens per second it only doubles the wall-clock of every gate, so it ships off.

The verifier thinks at `high`, the reference's setting for its DeepSeek-V4-Flash numbers (best-of-3 86.5% against 79.4% pass@1 on Terminal-Bench 2.1), and it gets room: `maxTokens` 65536, no thinking budget, calls stream. On a local DGX Spark pair a `high` call over a long trajectory takes two to twelve minutes; an earlier build lost such calls to a 300 s transport timeout, which looked like a hang. Now every call is a streamed response: tokens arrive while the model thinks, so no header timeout fires, an idle timer (`idleTimeoutMs`) aborts only a stream that goes silent, and `timeoutMs` is a last-resort cap of an hour. A gate over a long turn may therefore take ten minutes; it will end with a verdict, and the agent's harness imposes no tool timeout on the verifier tools. If you want speed over the reference setting, `reasoningEffort: low` gave verdicts within 0.06 of `high` on an A/B here at about a third of the time; `none` is a one-shot reading for chat sessions.

With thinking on, vLLM returns the reasoning tokens inside `logprobs.content` as well; the score reader walks the token stream and takes the letter after the last `<score>` tag, so that is handled. A reply that spends the whole budget on reasoning carries no answer and is reported as a failed call (retried once, then unscored), never as a 0.5.

`verifier_select` with three candidates is 5 pairs × 3 criteria × 2 repeats, about 30 calls; with thinking that is a few minutes on six slots.

## Unscored verdicts

A verifier reply sometimes carries no parseable score tag. The plugin retries such a call (`backend.retriesOnFallback`, default 1). What still has no verdict is excluded from every mean and reported as `scored: false`, never counted as a neutral 0.5. A gate pass with zero scored criteria closes the turn unverified and logs it instead of steering the agent on noise.

## Skill

`skills/graph-verified-coding/SKILL.md` is a dsh skill (also usable by Claude Code or Codex from `~/.agents/skills`) that tells the agent how to use the verifier inside a graph-engineered coding process. Seven steps, each with a done-condition: contract (acceptance criteria with observable artifacts), cut false edges (independent nodes in parallel, dependent ones in sequence), work node (keep the proving output), gate (tests, browser loop for rendered output, `verifier_assess` when evidence is ambiguous), join (`verifier_select` over competing candidates), cycle with a stop (repair and re-gate, bounded rounds), report with evidence. A reference block lists the tools and their cost so the agent places gates where they pay: before merges and before the final answer. Link it into a skill root dsh scans:

```sh
ln -s /path/to/dsh-verifier-gate/skills/graph-verified-coding ~/.dsh/skills/graph-verified-coding
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
