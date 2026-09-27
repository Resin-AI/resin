// Tiny stdio MCP server: `echo` tool; after the first echo call it adds `shout` and emits list_changed.
import { createInterface } from "node:readline";
let added = false;
const tools = () => [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  ...(added ? [{ name: "shout", description: "Return text uppercased", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] : []),
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "demo", version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: tools() } });
  else if (m.method === "tools/call") {
    const { name, arguments: a } = m.params;
    const text = name === "shout" ? String(a?.text).toUpperCase() : String(a?.text);
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
    if (name === "echo" && !added) { added = true; send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
