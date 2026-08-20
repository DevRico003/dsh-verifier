/**
 * Prompt builders and built-in criteria sets.
 *
 * Prefix-cache discipline (the reference implementation's 3.4× cost win):
 * everything invariant across criteria (task, trajectories, scale) comes
 * FIRST; only the criterion varies at the tail. Keep that ordering.
 */
import { PAIRWISE_SCALE_DESCRIPTION, PROGRESS_SCALE_DESCRIPTION } from './scale.js';
/** Generic answers, documents, explanations. */
const GENERAL = {
    groundTruthNote: '**Do NOT trust the agent\'s self-assessment or confident tone.** Judge only what the answer actually contains and what the observed tool output actually shows. An answer that claims success without evidence is not evidence.',
    criteria: [
        {
            id: 'correctness',
            name: 'Correctness',
            description: 'Is the final answer factually and logically correct for the task as stated? Check computations, claims, code, and reasoning steps for errors. Score HIGH only when the content is right; score LOW for wrong facts, broken logic, hallucinated details, or an answer to a different question. Ignore style, length, and formatting.',
        },
        {
            id: 'completeness',
            name: 'Completeness & specification adherence',
            description: 'Does the response address EVERY explicit requirement, constraint, and format demanded by the task (language, structure, counts, file names, output shape)? Score HIGH when all requirements are met; LOW when parts are missing, silently narrowed, or constraints were violated. Ignore correctness of the content itself, only coverage and adherence.',
        },
        {
            id: 'grounding',
            name: 'Grounding & verification',
            description: 'Are the claims supported by what the agent actually observed (tool output, files read, commands run) rather than asserted? Score HIGH when key claims are backed by observed evidence or the task needed none; LOW when the agent narrates results it never observed, ignores contradicting output, or declares success after errors. Ignore prose quality.',
        },
    ],
};
/** Coding / agentic tasks (ported from the swe_bench + terminal_bench criteria). */
const CODING = {
    groundTruthNote: '**Do NOT trust the agent\'s self-assessment or claims that "the patch looks correct" or "all tests pass".** Agents routinely declare success on changes that fix the wrong file, address only a symptom, or are subtly broken. Focus on OBSERVED tool output as ground truth, agents often claim success when the terminal shows errors.',
    criteria: [
        {
            id: 'specification',
            name: 'Specification adherence',
            description: 'Compare what the task literally demanded (exact paths, file names, formats, function names, languages, constraints, scope) with what the agent produced. "Right idea, wrong place" scores LOW. Score HIGH only when every concrete requirement was met as stated. Ignore code quality and verification here.',
        },
        {
            id: 'code_review',
            name: 'Code quality & root cause',
            description: 'Review the final change itself: syntactic validity, correct API/types/control flow, no off-by-one or swapped arguments, preserved signatures and behaviour of untouched paths, and WHERE the change lands, fixing the root cause scores HIGH, special-casing the literal example, catching bad output downstream, or dodging the broken path scores LOW. Pay attention to silent regressions in code paths the task did not mention. Judge by substance, not by length or apparent effort.',
        },
        {
            id: 'verification',
            name: 'Empirical verification & error signals',
            description: 'Did the agent actually run the relevant verification (tests, the program, the command the task names) and did the OBSERVED output match what the task calls for? Reward: reproducer built, failure observed before the fix, correct behaviour observed after, existing checks still passing. Penalize: editing again after the last successful verification (final state untested), unresolved tracebacks / non-zero exits / "command not found" in later steps, and success claims that the output contradicts. Ignore how the code looks.',
        },
    ],
};
/** Terminal / ops tasks (ported from terminal_bench). */
const TERMINAL = {
    groundTruthNote: '**Focus on TERMINAL OUTPUT as ground truth, not the agent\'s narration.** Agents often claim success when the terminal shows errors.',
    criteria: [
        {
            id: 'specification',
            name: 'Specification',
            description: 'Were the exact paths, file names, formats, flags and constraints the task states honoured? "Right idea, wrong place" (correct content in the wrong file, wrong directory, wrong format) scores LOW. Ignore output correctness and error handling here.',
        },
        {
            id: 'output_match',
            name: 'Output match',
            description: 'Find the FINAL verification command and compare its stdout character by character with what the task says should appear. Score HIGH when it literally matches; LOW when it differs, was never run, or the agent only asserts it would match.',
        },
        {
            id: 'error_signals',
            name: 'Error signals',
            description: 'Scan the later steps for tracebacks, segfaults, "command not found", permission errors, non-zero exit codes or warnings that were never fixed. Score HIGH when the trajectory ends clean; LOW when unresolved errors remain regardless of what the agent says.',
        },
    ],
};
export const CRITERIA_SETS = { general: GENERAL, coding: CODING, terminal: TERMINAL };
export const CRITERIA_SET_NAMES = Object.keys(CRITERIA_SETS);
/** Resolve a named set or a custom list; throws on an unknown name. */
export function resolveCriteria(name) {
    const set = CRITERIA_SETS[name];
    if (set === undefined)
        throw new Error(`dsh-verifier: unknown criteria set "${name}" (known: ${CRITERIA_SET_NAMES.join(', ')})`);
    return set;
}
export const PAIRWISE_TAG_A = 'score_A';
export const PAIRWISE_TAG_B = 'score_B';
export const ASSESS_TAG = 'score';
/** Pairwise comparison prompt, verbatim structure of the reference `build_prompt`. */
export function buildPairwisePrompt(problem, traceA, traceB, criterion, groundTruthNote) {
    return 'You are an expert evaluator of AI agents. You will see a task description and two agent trajectories, '
        + 'then evaluate them on ONE specific criterion, stated at the end.\n\n'
        + `${groundTruthNote}\n\n`
        + `**Task:**\n${problem}\n\n`
        + `**Trajectory A:**\n${traceA}\n\n`
        + `**Trajectory B:**\n${traceB}\n\n`
        + `**Rating Scale:**\n${PAIRWISE_SCALE_DESCRIPTION}\n\n`
        + `**Evaluation Guideline for ${criterion.name}:**\n${criterion.description}\n\n`
        + `Score each trajectory ONLY on this specific criterion ("${criterion.name}"). Ignore other aspects of the trajectory that are not relevant to it.\n\n`
        + 'Reason it through first, then END your reply with exactly these two lines and nothing after them. '
        + 'Replace each placeholder with a single letter A-T, keeping the spaces around the letter exactly as shown:\n'
        + `<${PAIRWISE_TAG_A}> LETTER_A_TO_T </${PAIRWISE_TAG_A}>\n`
        + `<${PAIRWISE_TAG_B}> LETTER_A_TO_T </${PAIRWISE_TAG_B}>\n\n`
        + 'Begin your analysis now.';
}
/**
 * Single-trajectory assessment prompt: the reference progress prompt reduced
 * to one checkpoint (the final state), scored on one criterion.
 */
export function buildAssessmentPrompt(problem, trajectory, criterion, groundTruthNote) {
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
        + 'Begin your analysis now.';
}
//# sourceMappingURL=prompts.js.map