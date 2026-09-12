import type { BrokerRequestHandlerFn } from "@resin/runtime";
import type { CallToolResult } from "../protocol/types.js";

interface CommandFailure {
  step: number;
  exitCode: number;
  stderr: string;
  truncated: boolean;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return value.slice(0, end);
}

/** Caller-facing diagnostics only; never persist command arguments or raw broker logs. */
export class CommandFailureDiagnostics {
  private commandCount = 0;
  private failureCount = 0;
  private failures: CommandFailure[] = [];

  constructor(private readonly workspaceRoot: string) {}

  get hasFailures(): boolean {
    return this.failureCount > 0;
  }

  wrap(handler: BrokerRequestHandlerFn): BrokerRequestHandlerFn {
    return async (service, action, payload) => {
      const step =
        service === "cmd" && (action === "execute" || action === "exec")
          ? ++this.commandCount
          : undefined;
      const result = await handler(service, action, payload);
      if (
        step !== undefined &&
        result !== null &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        "exitCode" in result &&
        typeof result.exitCode === "number" &&
        Number.isSafeInteger(result.exitCode) &&
        result.exitCode !== 0
      ) {
        // CommandBroker has already applied its secret redactor to stderr.
        const stderr = "stderr" in result && typeof result.stderr === "string" ? result.stderr : "";
        const normalized = this.workspaceRoot
          ? stderr.replaceAll(this.workspaceRoot, "<WORKSPACE>")
          : stderr;
        const bounded = utf8Prefix(normalized, 2048);
        this.failureCount++;
        this.failures.push({
          step,
          exitCode: result.exitCode,
          stderr: bounded,
          truncated:
            ("truncated" in result && result.truncated === true) ||
            bounded.length !== normalized.length,
        });
        this.failures.sort((left, right) => left.step - right.step);
        this.failures.length = Math.min(this.failures.length, 4);
      }
      return result;
    };
  }

  isReportedFailure(output: unknown): boolean {
    return (
      this.hasFailures &&
      output !== null &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      "success" in output &&
      output.success === false
    );
  }

  append(result: CallToolResult, maxOutputBytes: number): CallToolResult {
    if (!this.hasFailures) return result;
    // Account for JSON escaping, the content block wrapper and its array separator.
    const available = Math.min(
      8192,
      maxOutputBytes - Buffer.byteLength(JSON.stringify(result)) - 1,
    );
    if (available <= 0) return result;
    const failures = this.failures.map((failure) => ({ ...failure }));
    while (failures.length > 0) {
      const content = {
        type: "text" as const,
        text: JSON.stringify({
          commandFailures: failures,
          omittedCommandFailures: this.failureCount - failures.length,
        }),
      };
      if (Buffer.byteLength(JSON.stringify(content)) <= available) {
        return { ...result, content: [...result.content, content] };
      }
      const withStderr = [...failures].reverse().find((failure) => failure.stderr.length > 0);
      if (withStderr) {
        withStderr.stderr = utf8Prefix(
          withStderr.stderr,
          Math.floor(Buffer.byteLength(withStderr.stderr) / 2),
        );
        withStderr.truncated = true;
      } else {
        failures.pop();
      }
    }
    return result;
  }
}
