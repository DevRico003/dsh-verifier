/**
 * Serialize the current turn of a harness session into the verifier's
 * trajectory format (the reference loaders' `--- Agent Step n ---` /
 * `[Tool call]` / `[Output]` shape), bounded by character caps.
 */
function truncate(text, cap) {
    if (text.length <= cap)
        return text;
    return `${text.slice(0, cap)}... (truncated, +${text.length - cap} chars)`;
}
/** Sources whose message text is the task itself (the human, or the goal plugin's objective). */
export function isTaskSource(source) {
    return source.kind === 'user' || source.kind === 'goal';
}
function blockText(blocks) {
    return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
}
/**
 * Build the trajectory of turn `turn` from the session's event log.
 * @param events - full ordered session log.
 * @param turn - the turn number to serialize.
 * @param limits - character caps.
 */
export function buildTrajectory(events, turn, limits) {
    const own = buildTurn(events, turn, limits);
    const back = limits.continuationTurns ?? 1;
    if (back <= 0 || turn <= 1 || !isContinuation(own.firstTask))
        return own;
    // Continuation turns (auto-continue after an interruption, a goal round that
    // resumes) hold little of the work; the previous turn holds the edits and the
    // command output the verifier needs. Prepend it, oldest first, within the cap.
    const earlier = [];
    for (let t = Math.max(1, turn - back); t < turn; t++) {
        const previous = buildTurn(events, t, limits);
        if (previous.trace.trim() !== '')
            earlier.push(`=== Earlier turn ${t} (${previous.steps} steps) ===\n${previous.trace}`);
    }
    if (earlier.length === 0)
        return own;
    const combined = `${earlier.join('\n\n')}\n\n=== Current turn ${turn} ===\n${own.trace}`;
    const trace = combined.length > limits.maxTotalChars
        ? `(earlier content elided)\n\n${combined.slice(combined.length - limits.maxTotalChars)}`
        : combined;
    return { ...own, trace };
}
/** Share of the cap kept as the stable head when a trace is elided. */
const HEAD_SHARE = 0.2;
/**
 * Join the steps within `cap` characters. When they do not fit, keep the
 * opening steps (the task setup and first decisions, up to HEAD_SHARE of the
 * cap) and the most recent steps, and elide the middle. The head is the same
 * on every call, so a prefix-caching server reuses it across the gates of one
 * turn; the tail carries the evidence the verifier judges.
 */
export function elideMiddle(steps, cap) {
    const whole = steps.join('\n\n');
    if (whole.length <= cap || steps.length <= 1)
        return whole;
    const head = [];
    let headLength = 0;
    for (const step of steps) {
        if (headLength + step.length + 2 > cap * HEAD_SHARE)
            break;
        head.push(step);
        headLength += step.length + 2;
    }
    const tail = [];
    let tailLength = 0;
    for (let i = steps.length - 1; i >= head.length; i--) {
        const step = steps[i];
        if (headLength + tailLength + step.length + 2 + 60 > cap)
            break;
        tail.unshift(step);
        tailLength += step.length + 2;
    }
    if (tail.length === 0) {
        // One recent step alone is longer than what remains of the cap: keep it and let the caller truncate.
        tail.push(steps[steps.length - 1]);
    }
    const elided = steps.length - head.length - tail.length;
    const marker = `(${elided} middle step(s) elided; ${head.length} opening and ${tail.length} most recent step(s) kept)`;
    return [...head, marker, ...tail].join('\n\n');
}
/** A turn that opens with "Continue." (auto-continue, goal resume) rather than a fresh request. */
export function isContinuation(firstTask) {
    return /^\s*Continue\b/i.test(firstTask);
}
function buildTurn(events, turn, limits) {
    let inTurn = false;
    // The goal objective of a multi-turn goal run lives in an earlier turn; a later
    // turn often opens with "Continue." only. Carry the latest objective forward so
    // the verifier judges against the goal, not against "Continue.".
    let goalObjective = '';
    let goalInThisTurn = false;
    const taskParts = [];
    let firstTask = '';
    const pluginContexts = [];
    const steps = [];
    let current = [];
    let stepNumber = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let finalText = '';
    let lastToolName;
    const flush = () => {
        if (current.length === 0)
            return;
        stepNumber++;
        steps.push(`--- Agent Step ${stepNumber} ---\n${current.join('\n')}`);
        current = [];
    };
    for (const event of events) {
        if (event.type === 'turn/start') {
            if (event.data.turn === turn)
                inTurn = true;
            else if (inTurn)
                break;
            continue;
        }
        if (!inTurn) {
            if (event.type === 'user/message' && event.data.source.kind === 'goal')
                goalObjective = blockText(event.data.content);
            continue;
        }
        switch (event.type) {
            case 'user/message': {
                const text = blockText(event.data.content);
                if (event.data.source.kind === 'goal')
                    goalInThisTurn = true;
                // The task is what the human or the goal asked for. A goal round arrives with
                // `source.kind: 'goal'`; everything else (instructions, runtime snapshots,
                // plugin notices) is context for the verifier, not the task.
                if (isTaskSource(event.data.source)) {
                    if (taskParts.length === 0)
                        firstTask = text;
                    taskParts.push(text);
                }
                else if (text !== '')
                    pluginContexts.push(truncate(text, limits.maxStepChars));
                break;
            }
            case 'assistant/message': {
                flush();
                const text = blockText(event.data.message.content);
                if (text.trim() !== '') {
                    current.push(truncate(text, limits.maxStepChars));
                    finalText = text;
                }
                for (const block of event.data.message.content) {
                    if (block.type === 'tool-call') {
                        toolCalls++;
                        lastToolName = block.name;
                        current.push(`[Tool call] ${block.name} ${truncate(block.arguments, limits.maxStepChars)}`);
                    }
                }
                break;
            }
            case 'tool/result': {
                const content = event.data.message.content[0];
                const output = content === undefined ? '' : blockText(content.content);
                const isError = content?.isError === true || event.data.error !== undefined;
                if (isError)
                    toolErrors++;
                current.push(`[Output${isError ? ' ERROR' : ''}] ${truncate(output === '' ? '(no output)' : output, limits.maxStepChars)}`);
                break;
            }
            case 'turn/end':
                break;
            default:
                break;
        }
    }
    flush();
    let trace = elideMiddle(steps, limits.maxTotalChars);
    if (trace.length > limits.maxTotalChars)
        trace = truncate(trace, limits.maxTotalChars);
    const contextNote = pluginContexts.length === 0
        ? ''
        : `\n\n[Harness context injected during the turn]\n${pluginContexts.join('\n')}`;
    const task = !goalInThisTurn && goalObjective !== ''
        ? [`Goal objective (set in an earlier turn):\n${goalObjective}`, ...taskParts].join('\n\n')
        : taskParts.join('\n\n');
    return {
        task,
        ownTask: taskParts.length > 0,
        firstTask,
        trace: trace + contextNote,
        steps: stepNumber,
        toolCalls,
        toolErrors,
        finalText,
        ...lastToolName !== undefined ? { lastToolName } : {},
    };
}
/**
 * Whether an agent is a child (subagent, team member). Checked three ways
 * because hosts differ: `session.meta.parentSession` (current harness),
 * `session.parentSession` / `session.origin === 'subagent'` (session header
 * fields), and a `subagent/descriptor` event, which only child sessions carry.
 */
export function isChildSession(session) {
    if (session.meta?.parentSession !== undefined && session.meta.parentSession !== null)
        return true;
    if (session.parentSession !== undefined && session.parentSession !== null)
        return true;
    if (session.origin === 'subagent')
        return true;
    // The descriptor sits before turn/start for the harness's own subagent tool, but after it for
    // agents spawned by other plugins (dsh-mnemon task agents), so the whole log is scanned.
    for (const event of session.events) {
        if (event.type === 'subagent/descriptor')
            return true;
    }
    return false;
}
//# sourceMappingURL=trajectory.js.map