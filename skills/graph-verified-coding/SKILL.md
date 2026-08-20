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
   - For anything a browser renders: `frontend-verify` loop (`browser_open`, `browser_console`, `browser_read`, `browser_screenshot`), then `analyze_image` with `backend: detailed` on the screenshot for the visual verdict.
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
| `browser_*`, `mcp__playwright__browser_*`, `analyze_image` | see and interact with rendered output | local |

**Criteria sets** for the verifier tools: `coding` (specification, code quality and root cause, empirical verification) for code; `terminal` (specification, output match, error signals) for ops tasks; `general` for prose and answers.

**Gate placement.** Gate before merges and before the final answer. Skip gates on trivial single-edit steps; the cost is real and the verifier is a second opinion, not a substitute for running the code.

**Subagent contracts.** Give each child the full contract of its node and the evidence it must return (which command output, which file paths). A child that returns narration without evidence failed its node; repair or rerun it.

**Hand back to the user** when a criterion cannot be decided without them (missing access, conflicting requirements, destructive actions). A turn that ends in a question is not gated.
