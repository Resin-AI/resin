import { writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  BUILTIN_TOOLS,
  Settings,
  type ToolSession,
} from "@oh-my-pi/pi-coding-agent";

interface Request {
  name: string;
  parameters: Record<string, unknown>;
  cwd: string;
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
const factory = (BUILTIN_TOOLS as Record<string, ((session: ToolSession) => unknown) | undefined>)[
  request.name
];
if (!factory) throw new Error(`OMP native tool '${request.name}' is not available in the installed harness SDK`);

const settings = Settings.isolated({
  "tools.xdev": false,
  skillful: false,
  "memory.backend": "off",
});
const session = {
  cwd: request.cwd,
  hasUI: false,
  canPromptUser: false,
  restrictToolNames: true,
  settings,
  getSessionFile: () => null,
  getSessionSpawns: () => null,
} as ToolSession;
const tool = await factory(session);
if (!tool || typeof tool !== "object" || !("execute" in tool) || typeof tool.execute !== "function") {
  throw new Error(`OMP native tool '${request.name}' is disabled by the installed harness SDK`);
}
const result = await tool.execute(`resin-${randomUUID()}`, request.parameters);
const content: Array<{ type: "text"; text: string }> = [];
const parts: unknown[] = Array.isArray(result.content) ? result.content : [];
for (const part of parts) {
  if (
    part &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  ) {
    content.push({ type: "text", text: part.text });
  }
}
writeSync(1, JSON.stringify({ content, ...(result.isError === undefined ? {} : { isError: result.isError }) }));
