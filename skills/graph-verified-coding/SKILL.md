---
name: graph-verified-coding
description: Coding with verifier gates, for the dsh-verifier plugin. Load for coding work that spans more than one file or step, has competing approaches, or runs unattended (goal, headless, subagents), and whenever the user says verify, gate, or best-of. Cuts the task into nodes with contracts, gates each node with evidence and verifier_assess, joins candidates with verifier_select, repairs in bounded cycles, reports with evidence.
---

# Graph-verified coding

`dsh-verifier` gives you a second reader. `verifier_assess` scores one result against three criteria, `verifier_select` ranks candidates, `ui_snapshot` renders pages headless, a checkpoint scores the running turn every forty steps, and a gate at the end of every turn scores the whole turn and sends you back when it falls below the threshold. This skill is how to work so those calls change the outcome instead of decorating it.

Five words carry the method. A **node** is one bounded unit of work with a **contract**: input, output, the command that proves it. An **edge** exists only where the next node reads the previous node's output. A **gate** decides whether work continues. A **join** merges parallel branches. A **cycle** is WORK, VERIFY, REPAIR with a hard stop.

**Evidence** is observed output: stdout, a test report, a rendered page, a verifier score. Your narration is not evidence. Every gate and the final report rest on evidence.

## Steps

1. **Contract.** Restate the task as acceptance criteria an observer could check: which files, which behaviour, which command proves it. Unattended work puts the contract into the goal text. Done when every criterion names an observable artifact.

2. **Cut false edges.** List the nodes. For each pair ask whether the next node reads the previous node's output; where it does not, the edge goes. Independent nodes run in parallel through `subagent`, at most two to four at once because every branch shares the model slots; dependent nodes run inline in sequence. Each child gets its node's full contract and writes its complete result to `.graph/<node>.md` in the workspace, ending its closing message with that path and a ten-line summary. Some hosts hand you a child's `report` only when your turn ends, so read the file as soon as the child settles, before starting a node that depends on it. Done when every remaining edge carries real data and every child knows its file.

3. **Work node.** Implement one node against its contract. Run the proving command inside the node (tests, the program, curl) and keep the output. Done when the contract is met with observed output in hand and the node's gate (step 4) has passed.

4. **Gate.** After every node that changed more than one file, before every merge, and before the final answer:
   - Deterministic first: tests, type check, lint, the command the task names. Fix the root cause.
   - Rendered output: `ui_snapshot(url)` gives PNGs for every viewport in light and dark plus console and page errors; clear the errors, then `analyze_image` with `backend: detailed` on each path for the visual verdict. Clicking, typing and DOM reads go through the headless `browser_open`, `browser_interact`, `browser_read`, `browser_console`.
   - Then `verifier_assess` with `criteria: coding`, the node's contract as `task`, the work plus its observed evidence as `answer`. It reads your current turn's trajectory by default, so the evidence must be in tool output, not only in your summary. Read `findings` per criterion; repair what is right, rebut in one sentence what is wrong.
   Done when every acceptance criterion has a passing observation and `pass` is true with `scoredCriteria` above zero. A result with `scoredCriteria: 0` is a backend failure, never a verdict: report it and continue on the deterministic checks.

5. **Join.** Competing candidates (patches, designs, plans) are ranked with `verifier_select`; two candidates with `verifier_compare`. Merge the winner, then gate the merged result (step 4). Done when one candidate is chosen with its score and the merge passed its gate.

6. **Cycle with a stop.** On a failed gate: repair, re-run the gate. Bound the cycle before you start, two rounds as the norm, three for risky changes. On the last failed round stop and report the open findings. Done when the gate passes or the round budget is spent and the report names what is still open.

7. **Report with evidence.** What was verified and how (commands, test counts, snapshot paths, every verifier call with score and `scoredCriteria`), what was not verified and why, the open findings. Done when a reader can reproduce every claim.

Three messages come from the plugin itself. `[dsh-verifier]` after your turn is the end-of-turn gate: a failed gate, so repair, re-verify, answer. `[dsh-verifier checkpoint]` during your turn is a mid-turn reading of the trajectory so far with findings: act on the findings in the current node, then continue. `[dsh-verifier] N file edits since your last verifier call` is gate debt: gate the node now (proving command, then `verifier_assess`), then continue. A finding that is mistaken gets one sentence saying why.

## Reference

**The tools.**

| Tool | Call | Returns |
| --- | --- | --- |
| `verifier_assess` | `task`, `answer`, `criteria` (coding, terminal, general), `evaluations`, `includeTrajectory` (default true) | `score` 0..1, `pass`, `threshold`, `scoredCriteria`, per-criterion `score`, `scored`, `source`, `findings`, `backend` |
| `verifier_compare` | `task`, `a`, `b`, `criteria` | `rewardA`, `rewardB` in 0..1 |
| `verifier_select` | `task`, `candidates[]`, `criteria` | `bestIndex`, `scores`, `ranking`, `comparisons` |
| `ui_snapshot` | `url`, `viewports` (default 1440x900 and 390x844), `colorSchemes` (default both), `fullPage`, `waitForSelector`, `settleMs`, `label` | `shots[]` with `path`, `consoleErrors`, `pageErrors`, `failedRequests` |

**Criteria sets.** `coding`: specification adherence, code quality and root cause, empirical verification. `terminal`: specification, literal output match, unresolved error signals. `general`: correctness, completeness, grounding.

**Reading a verdict.** `score` is the mean over criteria of an expectation over the verifier's letter distribution, so 0.72 means the verifier leans yes with doubt, 0.95 means it saw the proof. `source: logprobs` is the full reading, `text` a single sampled letter, and `scored: false` means that criterion produced no verdict. `findings` is the verifier's analysis and names what is missing, wrong or unverified; it is written to be acted on.

**Cost.** The verifier thinks (effort high). One `verifier_assess` is three calls, about one to two minutes on a long turn because the trajectory is prefilled once and the other two calls hit the cache. `verifier_select` over three candidates is about thirty calls. Place gates where they pay: one per completed multi-file node, one per merge, one before the final answer. For N such nodes expect at least N + 1 calls; a long build with two calls means the node gates were skipped.

**Design rounds.** `ui_snapshot` before, `analyze_image` on each shot with a concrete question (contrast, spacing, hierarchy, clipped content, consistency with the design guidelines in use), change the code, `ui_snapshot` after with a `label` such as `round-2-after`, `analyze_image` again, keep both paths for the report. Two rounds minimum when the task names design quality; stop when a round yields no finding.

**Hand back to the user** when a criterion cannot be decided without them (missing access, conflicting requirements, destructive actions). A turn that ends in a question is not gated.
