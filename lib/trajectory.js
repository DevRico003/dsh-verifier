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
    let inTurn = false;
    const taskParts = [];
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
        if (!inTurn)
            continue;
        switch (event.type) {
            case 'user/message': {
                const text = blockText(event.data.content);
                if (event.data.source.kind === 'user')
                    taskParts.push(text);
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
    // Elide the oldest steps first when the whole trace exceeds the cap.
    let kept = steps;
    let trace = kept.join('\n\n');
    let elided = 0;
    while (trace.length > limits.maxTotalChars && kept.length > 1) {
        kept = kept.slice(1);
        elided++;
        trace = `(${elided} earlier step(s) elided)\n\n${kept.join('\n\n')}`;
    }
    if (trace.length > limits.maxTotalChars)
        trace = truncate(trace, limits.maxTotalChars);
    const contextNote = pluginContexts.length === 0
        ? ''
        : `\n\n[Harness context injected during the turn]\n${pluginContexts.join('\n')}`;
    return {
        task: taskParts.join('\n\n'),
        trace: trace + contextNote,
        steps: stepNumber,
        toolCalls,
        toolErrors,
        finalText,
        ...lastToolName !== undefined ? { lastToolName } : {},
    };
}
//# sourceMappingURL=trajectory.js.map