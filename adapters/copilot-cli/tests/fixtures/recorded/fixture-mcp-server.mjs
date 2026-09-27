import { createInterface } from "node:readline";
const tools = [
  {
    name: "echo_upper",
    description: "Uppercase the given text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "learn_tool",
    description: "Registers a new tool named count_chars (notifies tools/list_changed).",
    inputSchema: { type: "object", properties: {} },
  },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  if (msg.method === "tools/call") {
    const { name, arguments: a } = msg.params;
    if (name === "echo_upper")
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: String(a.text).toUpperCase() }] },
      });
    if (name === "learn_tool") {
      if (!tools.some((t) => t.name === "count_chars"))
        tools.push({
          name: "count_chars",
          description: "Count characters in text.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        });
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "learned count_chars" }] },
      });
      return send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    if (name === "count_chars")
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: String(String(a.text).length) }] },
      });
    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } });
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
