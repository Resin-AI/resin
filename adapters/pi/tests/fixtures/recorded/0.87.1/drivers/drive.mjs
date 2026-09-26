import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [cwd, sessionDir, ...extra] = process.argv.slice(2);
const child = spawn("pi", ["--mode", "rpc", "--provider", "openai-codex", "--model", "gpt-5.6-luna", "--thinking", "low", "--no-extensions", "-e", "/tmp/resin-fixture-pi-mcp/rewind.ts", "--session-dir", sessionDir, ...extra], { cwd, stdio: ["pipe", "pipe", "inherit"] });
const waiters = [];
let reqId = 0;
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== "message_update" && m.type !== "tool_execution_update") console.error("<", m.type, m.command ?? "", m.success === false ? m.error : "");
  for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
});
const waitFor = (match) => { const r = Promise.withResolvers(); waiters.push({ match, resolve: r.resolve }); return r.promise; };
const send = (cmd) => { const id = `r${++reqId}`; const resp = waitFor((m) => m.type === "response" && m.id === id); child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n"); return resp; };
const prompt = async (message) => { const end = waitFor((m) => m.type === "agent_end"); await send({ type: "prompt", message }); await end; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastUser = async () => { const r = await send({ type: "get_fork_messages" }); return r.data.messages.at(-1); };

await prompt("Use the bash tool to run `ls` and tell me how many files there are. Be brief.");
await prompt("What is 2+2? Answer with just the number.");
const branchTarget = await lastUser();
await send({ type: "prompt", message: `/rewind ${branchTarget.entryId}` });
await sleep(8000);
await prompt("What is 3+3? Answer with just the number.");
console.error(JSON.stringify(await send({ type: "set_model", provider: "openai-codex", modelId: "gpt-5.6-terra" })).slice(0, 200));
await prompt("Say hi in one word.");
await send({ type: "bash", command: "echo rpc-bash" });
console.error(JSON.stringify(await send({ type: "compact" })).slice(0, 300));
const aborted = waitFor((m) => m.type === "agent_end");
await send({ type: "prompt", message: "Use the bash tool to run `sleep 30 && echo late`." });
await waitFor((m) => m.type === "tool_execution_start");
await sleep(1500);
await send({ type: "abort" });
await aborted;
const first = (await send({ type: "get_fork_messages" })).data.messages[0];
console.error(JSON.stringify(await send({ type: "fork", entryId: first.entryId })).slice(0, 200));
await prompt("Reply with just FORKED.");
child.stdin.end();
child.kill();
