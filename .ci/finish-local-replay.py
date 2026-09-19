from pathlib import Path


def patch(path, edits):
    target = Path(path)
    source = target.read_text()
    for old, new in edits:
        if source.count(old) != 1:
            raise RuntimeError(f"Expected one unchanged anchor in {path}: {old[:80]!r}")
        source = source.replace(old, new)
    target.write_text(source)


patch("apps/observer/src/normalization/pipeline.ts", [
    ('import type { JsonObject, JsonValue } from "./redaction.js";',
     'import { retainLocalWorkflowPayload } from "./local-workflow-payload.js";\nimport type { JsonObject, JsonValue } from "./redaction.js";'),
    ('    // 6. Update session causal tracking state',
     '    // Exact payloads remain local and non-serializable; stored events stay redacted.\n    retainLocalWorkflowPayload(validEvent, payloadFields);\n\n    // 6. Update session causal tracking state'),
])

patch("apps/observer/src/analytics/workflow-call-recorder.ts", [
    ('import { extractComputationSourceFrames } from "./computation/source-frames.js";',
     'import { localWorkflowEvent } from "../normalization/local-workflow-payload.js";\nimport { extractComputationSourceFrames } from "./computation/source-frames.js";'),
    ('  private observeAccess: PrivateValueOrigin | undefined;',
     '  private observeAccess: PrivateValueOrigin | undefined;\n  private privateRepresentation: "literal" | "redacted" = "redacted";\n  private redactedArguments: Record<string, WorkflowJsonValue> | undefined;'),
    ('    this.observeAccess = access;',
     '    this.observeAccess = access;\n    this.redactedArguments = event.type === "tool_call" ? event.parameters : undefined;\n    const original = localWorkflowEvent(event);\n    this.privateRepresentation = original !== undefined || !event.redaction.isRedacted ? "literal" : "redacted";'),
    ('    if (event.type === "tool_result") return this.observeResult(event);',
     '    if (event.type === "tool_result") {\n      const observed = this.observeResult(original ?? event, event);\n      return { ...event, metadata: observed.metadata };\n    }'),
    ('    if (isInvokeToolCallName(event.toolName)) return this.observeComposedCall(event);\n    return this.observeNativeCall(event);',
     '    if (isInvokeToolCallName(event.toolName)) {\n      this.privateRepresentation = "redacted";\n      return this.observeComposedCall(event);\n    }\n    const observed = this.observeNativeCall(localWorkflowEvent(event) ?? event);\n    // Only reference-bearing metadata leaves the local raw view.\n    return { ...event, metadata: observed.metadata };'),
    ('    const program = this.programOf(event, parameters);\n    const analysis = analyzeAgentArguments(parameters);',
     '    const program = this.programOf(event, parameters);'),
    ('    for (const [argument, origin] of Object.entries(analysis.origins)) {\n      origins[argument] = this.launderOrigin(origin, event.sessionId, event.callId, [argument]);',
     '    // Ordinary native JSON is data, not the explicit composition interface.\n    for (const [argument, value] of Object.entries(parameters)) {\n      origins[argument] = this.launderOrigin({ type: "literal", value }, event.sessionId, event.callId, [argument]);'),
    ('    const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);\n    return `private:${namespace}:${digest}`;',
     '    const digest = createHash("sha256")\n      .update(JSON.stringify([this.observeAccess?.workspaceId ?? null, this.privateRepresentation, ...parts]))\n      .digest("hex");\n    return `private:v2:${namespace}:${digest}`;'),
    ('    const heldLocally = Object.entries(parameters)',
     '    const heldLocally = Object.entries(this.redactedArguments ?? parameters)'),
    ('  private observeResult(event: NormalizedSessionEvent): NormalizedSessionEvent {',
     '  private observeResult(event: NormalizedSessionEvent, publicEvent: NormalizedSessionEvent = event): NormalizedSessionEvent {'),
    ('    const handle = this.resultHandle(event);',
     '    const handle = this.resultHandle(publicEvent);'),
    ('  arguments: Record<string, WorkflowJsonValue>;\n  result?: WorkflowJsonValue;',
     '  arguments: Record<string, WorkflowJsonValue>;\n  argumentReferences: Record<string, string>;\n  result?: WorkflowJsonValue;\n  resultReference?: string;'),
    ('      arguments: parameters,\n      ...(discovered?.inputSchema',
     '      arguments: parameters,\n      argumentReferences: Object.fromEntries(Object.entries(parameters).map(([argument, value]) => [\n        argument, this.localReference(value, event.sessionId, event.callId, `argument:${argument}`),\n      ])),\n      ...(discovered?.inputSchema'),
    ('      for (const [argument, value] of Object.entries(mine.arguments)) {',
     '      for (const [argument, reference] of Object.entries(mine.argumentReferences)) {'),
    ('          reference: this.localReference(value, sessionId, mine.callId, `argument:${argument}`),',
     '          reference,'),
    ('      if (mine.result !== undefined) {\n        observed.push({\n          position: mine.position,\n          reference: this.localReference(mine.result, sessionId, mine.callId, "result"),',
     '      if (mine.resultReference !== undefined) {\n        observed.push({\n          position: mine.position,\n          reference: mine.resultReference,'),
    ('        call.result = extractResultValueOf(event.result);',
     '        call.result = extractResultValueOf(event.result);\n        call.resultReference = call.result === undefined ? undefined\n          : this.localReference(call.result, event.sessionId, call.callId, "result");'),
    ('if (execution.accumulatedHeldOut !== undefined && call.result !== undefined) {',
     'if (execution.accumulatedHeldOut !== undefined && call.resultReference !== undefined) {'),
    ('reference: this.localReference(call.result, event.sessionId, call.callId, "result"),',
     'reference: call.resultReference,'),
    ('this.heldOutSoFar(state, call, event.sessionId)', 'this.heldOutSoFar(state, call)'),
    ('  private heldOutSoFar(\n    state: SessionDerivationState,\n    call: LocalCall,\n    sessionId: string,',
     '  private heldOutSoFar(\n    state: SessionDerivationState,\n    call: LocalCall,'),
])
path = Path("apps/observer/src/analytics/workflow-call-recorder.ts")
source = path.read_text()
old = 'this.privateValues.set(reference, value, this.observeAccess);'
if source.count(old) != 2:
    raise RuntimeError("The two recorded-value writers changed")
path.write_text(source.replace(old, 'this.privateValues.set(reference, value, this.observeAccess, this.privateRepresentation);'))
