import { createInterface } from "node:readline";
const tools = [
  {
    name: "word_count",
    description: "Count the words in a piece of text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to count" } },
      required: ["text"],
    },
  },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize")
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fixture", version: "1" },
      },
    });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  else if (msg.method === "tools/call") {
    const n = String(msg.params.arguments.text ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: `words: ${n}` }] },
    });
  } else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
});
