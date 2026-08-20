---
name: graph-verified-coding
description: Graph-engineered coding with verification gates. Use for any coding task that touches more than one file or step, offers more than one viable approach, runs unattended (goal, headless, team), or whenever the user says verify, gate, best-of, parallel, team, or workflow. Turns the task into nodes with contracts, cuts false edges, gates every merge and the final answer with evidence and the verifier tools, and repairs in bounded cycles.
---

# Graph-verified coding

Treat a coding task as a graph, never as a straight line. A **node** is one bounded unit of work with a **contract** (input, output, failure states). An **edge** exists only where the next node reads the previous node's output. A **gate** is a check that decides whether work continues. A **join** merges parallel branches. A **cycle** is WORK then VERIFY then REPAIR, with a hard stop.

**Evidence** means observed output: a command's stdout, a test report, a rendered page, a screenshot description. Your own narration is not evidence. Every gate and every final report rests on evidence.

## Steps

1. **Contract.** Restate the task as acceptance criteria that an observer could check: which files, which behaviour, which command proves it. Done when every criterion names an observable artifact. For unattended work put the contract into the goal text.

2. **Cut false edges.** List the nodes. For each pair ask: does the next node read the previous node's output? If not, cut the edge. Independent nodes run in parallel through `subagent` (fresh context) or the `workflow` tool (`parallel`, `pipeline`); dependent nodes run in sequence inline. Keep the graph small: two to four parallel branches on this backend, because every branch shares the same model slots. Done when every remaining edge carries real data.

3. **Work node.** Implement one node at a time against its contract. Run the proving command inside the node (tests, the program, curl) and keep the output. Done when the node's contract is met with observed output in hand.

4. **Gate.** Before a merge and before the final answer, verify:
   - Deterministic first: tests, type checks, lint, the command the task names. Fix the root cause, never the symptom.
   - For anything a browser renders: `ui_snapshot(url)` (headless, every viewport in light and dark in one call, console and page errors included), then `analyze_image` with `backend: detailed` on each returned path for the visual verdict. Fix console and page errors before judging the look. For clicking, typing and reading the DOM use the headless `browser_open`, `browser_interact`, `browser_read`, `browser_console`. Both leave the user's screen alone. `computer_observe` and `computer_action` drive the user's real desktop; they are for tasks about the user's desktop, never for checking your own web work.
   - When evidence is ambiguous or the task is judgement-heavy: `verifier_assess` with the task text and the work plus its evidence; read the findings, repair what is right, rebut briefly what is wrong.
   Done when every acceptance criterion has a passing observation.

5. **Join.** When branches produced competing candidates (patches, designs, plans), pick with `verifier_select` (pairwise pivot tournament) instead of intuition; for two candidates `verifier_compare`. Merge the winner, then gate the merged result (step 4). Done when one candidate is chosen with its score and the merge passed its gate.

6. **Cycle with a stop.** On a failed gate: repair, then re-run the gate. Bound the cycle before you start (normally two rounds, three for risky changes). On the last failed round stop and report the open findings instead of declaring success. Done when the gate passes or the round budget is spent and the report names what is still open.

7. **Report with evidence.** State what was verified and how (commands, test counts, screenshots, verifier scores), what was not verified and why, and the open findings. Done when a reader can reproduce every claim from the report.

If a `[dsh-verifier]` message arrives after your turn, treat it as a failed gate: repair, re-verify, answer. If a finding is mistaken, say why in one sentence and finish.

## Reference

**Tools and cost on this setup** (one model, six parallel slots, verifier calls run without thinking):

| Tool | Use | Cost |
| --- | --- | --- |
| `verifier_assess(task, answer)` | gate for one result, returns score and findings | 3 calls (one per criterion) |
| `verifier_compare(task, a, b)` | directed pairwise reward | 3 × evaluations calls |
| `verifier_select(task, candidates[])` | best-of-N join, N + k(N-k) pairs | pairs × 3 × evaluations calls (3 candidates ≈ 30) |
| `subagent` / `subagent_fork` | parallel or context-inheriting node | one model stream each |
| `workflow` | scripted graph: `agent()`, `parallel()`, `pipeline()` | one stream per agent |
| `ralph` | repeated fresh-agent rounds on one objective | one stream per round |
| `ui_snapshot(url)` | headless PNGs per viewport and colour scheme plus console/page errors, for `analyze_image` | local, about 2 s per shot |
| `browser_open`, `browser_interact`, `browser_read`, `browser_console` | headless interaction and DOM reads | local |
| `analyze_image(path, backend: detailed)` | visual verdict on a screenshot | one vision call |

**Criteria sets** for the verifier tools: `coding` (specification, code quality and root cause, empirical verification) for code; `terminal` (specification, output match, error signals) for ops tasks; `general` for prose and answers.

**Design rounds.** A UI improvement round is: `ui_snapshot` before, `analyze_image` on each shot with a concrete question (contrast, spacing, hierarchy, clipped content, consistency with the design guidelines in use), change the code, `ui_snapshot` after with a `label` such as `round-2-after`, `analyze_image` again, keep both paths for the report. Two rounds minimum when the task names design quality; stop when a round yields no finding.

**Gate placement.** Gate before merges and before the final answer. Skip gates on trivial single-edit steps; the cost is real and the verifier is a second opinion, not a substitute for running the code.

**Subagent contracts.** Give each child the full contract of its node and the evidence it must return (which command output, which file paths). A child that returns narration without evidence failed its node; repair or rerun it.

**Hand back to the user** when a criterion cannot be decided without them (missing access, conflicting requirements, destructive actions). A turn that ends in a question is not gated.
