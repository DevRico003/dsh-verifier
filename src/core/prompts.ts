/**
 * Prompt builders and built-in criteria sets.
 *
 * Prefix-cache discipline (the reference implementation's 3.4× cost win):
 * everything invariant across criteria (task, trajectories, scale) comes
 * FIRST; only the criterion varies at the tail. Keep that ordering.
 */

import { PAIRWISE_SCALE_DESCRIPTION, PROGRESS_SCALE_DESCRIPTION } from './scale.js'

export interface Criterion {
  id: string
  name: string
  description: string
}

export interface CriteriaSet {
  /** Injected into every comparison; the anti-sycophancy instruction. */
  groundTruthNote: string
  criteria: Criterion[]
}

/** Generic answers, documents, explanations (own set; the reference ships task-specific criteria files). */
const GENERAL: CriteriaSet = {
  groundTruthNote:
    '**Do NOT trust the agent\'s self-assessment or claims of success.** Judge only what the answer actually contains and what the observed tool output actually shows.',
  criteria: [
    {
      id: 'correctness',
      name: 'Correctness',
      description:
        'Compare the agent\'s final answer against what the task actually asked for. Check computations, claims, code and reasoning steps for errors. Score HIGH only when the content is right; score LOW for wrong facts, broken logic, invented details, or an answer to a different question. Ignore style, length and formatting.',
    },
    {
      id: 'completeness',
      name: 'Completeness',
      description:
        'Does the response address EVERY explicit requirement, constraint and format the task demands (language, structure, counts, file names, output shape)? Score HIGH when all requirements are met; LOW when parts are missing, silently narrowed, or constraints were violated. Ignore whether the content itself is correct; judge coverage and adherence only.',
    },
    {
      id: 'grounding',
      name: 'Grounding',
      description:
        'Are the claims supported by what the agent actually observed (tool output, files read, commands run) rather than asserted? Score HIGH when key claims are backed by observed evidence, or the task needed none; LOW when the agent narrates results it never observed, ignores contradicting output, or declares success after errors. Ignore prose quality.',
    },
  ],
}

/**
 * Coding tasks. From the reference criteria files: `specification` from
 * terminal_bench.md, `code_review` and `verification` from swe_bench.md, with
 * "issue" read as "task" and the patch defined as diff output or the file
 * contents written through tools, since a harness trajectory carries edits as
 * tool calls rather than as one diff.
 */
const CODING: CriteriaSet = {
  groundTruthNote:
    '**Do NOT trust the agent\'s self-assessment or claims that "the patch looks correct". Agents routinely declare success on patches that fix the wrong file, address only a symptom, or are subtly broken. Focus on OBSERVED tool output as ground truth; agents often claim success when the terminal shows errors.**',
  criteria: [
    {
      id: 'specification',
      name: 'Specification Adherence',
      description:
        'Re-read the task description and check the SPECIFIC requirements: exact file paths, install locations, output formats, naming, and any explicit constraints (e.g. "no X11 support", "install to /usr/local/bin/X", "output JSON to /app/out.json"). Did the agent meet these specific requirements, or did they produce a solution that solves a similar but different problem (right idea, wrong place / wrong format / missing constraint)?',
    },
    {
      id: 'code_review',
      name: 'Code Quality',
      description:
        'Review the agent\'s final patch (a `diff --git ...` output, or the file contents the agent wrote and edited through its tools, as shown in the trajectory) as an experienced code reviewer would. Check syntactic validity, semantic correctness (right API, right types, right control flow, no off-by-one, no swapped arguments, no shadowed or unbound names), preservation of existing contracts (function signatures, return types, exception types and messages, output formats, default behavior), and consistency with surrounding code style. Pay attention to silent regressions in code paths the task did not explicitly mention; these are the most common cause of a patch that looks fine but breaks something else. Judge the diff on its technical merits, not by length or apparent effort.',
    },
    {
      id: 'verification',
      name: 'Empirical Verification',
      description:
        'Look at the commands the agent actually ran and what they printed, not what the agent claimed in its narration. Reward agents that (a) constructed a reproducer for the failure described in the task, (b) observed the failure before applying the fix, (c) observed the expected correct behavior after the fix, and (d) ran the existing tests in the affected module without breaking them. Trust observed command output over the agent\'s narration of it. Penalize agents that declared success without running anything, misread their own command output (e.g. compared a literal string to itself, ignored a traceback, claimed a test passed when it errored), or edited the code again after the last successful verification step so the final patch is untested.',
    },
  ],
}

/** Terminal / ops tasks. Verbatim from the reference terminal_bench.md. */
const TERMINAL: CriteriaSet = {
  groundTruthNote:
    '**IMPORTANT:** Focus on TERMINAL OUTPUT as ground truth. Do NOT trust the agent\'s self-assessment or claims of success. Agents often claim success when the terminal shows errors.',
  criteria: [
    {
      id: 'specification',
      name: 'Specification Adherence',
      description:
        'Re-read the task description and check the SPECIFIC requirements: exact file paths, install locations, output formats, naming, and any explicit constraints (e.g. "no X11 support", "install to /usr/local/bin/X", "output JSON to /app/out.json"). Did the agent meet these specific requirements, or did they produce a solution that solves a similar but different problem (right idea, wrong place / wrong format / missing constraint)?',
    },
    {
      id: 'output_match',
      name: 'Output Match',
      description:
        'Find the FINAL verification command the agent ran (the one that should prove the solution works). Compare its actual stdout/stderr output, character-by-character if needed, to what the task description says the output should look like. For example: if the task says it should print "Results: X Y Z" with integers, did the agent\'s last test actually print that? If the task asks for a JSON file, do the values look plausible and well-formed in the cat output? Reward trajectories whose terminal SHOWS the expected output literally. Ignore everything except whether the observed output matches the expected output.',
    },
    {
      id: 'error_signals',
      name: 'Error Signal Detection',
      description:
        'Scan the trajectory, especially the later steps, for explicit failure markers: error messages, exception tracebacks, segmentation faults, "command not found", "No such file or directory", non-zero exit codes that the agent did not subsequently fix, compilation failures, test failures, etc. A trajectory that ends with unresolved errors is almost certainly broken even if the agent claims success. Conversely, a clean trajectory whose final commands all succeed without errors is a strong positive signal. Score based ONLY on the presence/absence of unresolved error signals.',
    },
  ],
}

export const CRITERIA_SETS: Record<string, CriteriaSet> = { general: GENERAL, coding: CODING, terminal: TERMINAL }

export const CRITERIA_SET_NAMES = Object.keys(CRITERIA_SETS)

/** Resolve a named set or a custom list; throws on an unknown name. */
export function resolveCriteria(name: string): CriteriaSet {
  const set = CRITERIA_SETS[name]
  if (set === undefined) throw new Error(`dsh-verifier-gate: unknown criteria set "${name}" (known: ${CRITERIA_SET_NAMES.join(', ')})`)
  return set
}

export const PAIRWISE_TAG_A = 'score_A'
export const PAIRWISE_TAG_B = 'score_B'
export const ASSESS_TAG = 'score'

/** Pairwise comparison prompt, verbatim structure of the reference `build_prompt`. */
export function buildPairwisePrompt(
  problem: string,
  traceA: string,
  traceB: string,
  criterion: Criterion,
  groundTruthNote: string,
): string {
  return 'You are an expert evaluator of AI coding agents. You will see a task description and two agent trajectories, '
    + 'then evaluate them on ONE specific criterion, stated at the end.\n\n'
    + `${groundTruthNote}\n\n`
    + `**Task:**\n${problem}\n\n`
    + `**Trajectory A:**\n${traceA}\n\n`
    + `**Trajectory B:**\n${traceB}\n\n`
    + `**Rating Scale:**\n${PAIRWISE_SCALE_DESCRIPTION}\n\n`
    + `**Evaluation Guideline — ${criterion.name}:**\n${criterion.description}\n\n`
    + `Score each trajectory ONLY on this specific criterion ("${criterion.name}"). Ignore other aspects of the trajectory that are not relevant to it.\n\n`
    + 'Reason it through first, then END your reply with exactly these two lines and nothing after them. '
    + 'Replace each placeholder with a single letter A-T, keeping the spaces around the letter exactly as shown:\n'
    + `<${PAIRWISE_TAG_A}> LETTER_A_TO_T </${PAIRWISE_TAG_A}>\n`
    + `<${PAIRWISE_TAG_B}> LETTER_A_TO_T </${PAIRWISE_TAG_B}>\n\n`
    + 'Begin your analysis now.'
}

/**
 * Single-trajectory assessment prompt: the reference progress prompt reduced
 * to one checkpoint (the final state), scored on one criterion.
 */
export function buildAssessmentPrompt(
  problem: string,
  trajectory: string,
  criterion: Criterion,
  groundTruthNote: string,
): string {
  return 'You are a strict, skeptical evaluator of agent task attempts. Agents routinely declare victory while their '
    + 'environment still shows errors, edit the wrong target, or never actually run the verification the task asks for. '
    + 'Trust observed output, NOT the agent\'s narration.\n\n'
    + `${groundTruthNote}\n\n`
    + `**Task instruction:**\n${problem}\n\n`
    + `**Agent trajectory (each step is one action by the agent, with its observed output; the final assistant message is the agent's answer to the user):**\n${trajectory}\n\n`
    + 'You will score the FINAL state of this trajectory. The score measures exactly ONE thing:\n\n'
    + '    "Given everything the agent has done, would the agent\'s CURRENT state and final answer actually satisfy the task\'s '
    + 'hidden grader (i.e. produce the expected files / output / behaviour / answer the task requires)?"\n\n'
    + `${PROGRESS_SCALE_DESCRIPTION}\n\n`
    + 'CRITICAL CALIBRATION RULES:\n'
    + '  * Effort, exploration, step count, and confident-sounding narration are NOT progress. An agent that ran 20 commands and still has not produced the right output deserves a score near A.\n'
    + '  * Default to skepticism. The hidden grader is NOT visible to you. A result with no real verification step should not exceed ~K, and even a verified-looking one should rarely exceed ~R unless the verification clearly matches the task\'s stated success criterion.\n'
    + '  * Treat the agent\'s prose declarations ("done!", "all tests pass") as ZERO evidence. Ground your score in the actual actions and the actual output you can see.\n'
    + '  * A pure question-answering task with no tools needed is verified by the correctness of the answer itself; do not demand tool runs where none make sense.\n\n'
    + `**Evaluation Guideline for ${criterion.name}:**\n${criterion.description}\n\n`
    + `Score ONLY on this specific criterion ("${criterion.name}"). Ignore other aspects that are not relevant to it.\n\n`
    + 'Reason it through first, name concretely what is missing, wrong, or unverified, because that analysis is fed back to the agent, '
    + 'then END your reply with exactly this line and nothing after it. Replace the placeholder with a single letter A-T, keeping the spaces around the letter exactly as shown:\n'
    + `<${ASSESS_TAG}> LETTER_A_TO_T </${ASSESS_TAG}>\n\n`
    + 'Begin your analysis now.'
}
