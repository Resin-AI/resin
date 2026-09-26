import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [cwd, sessionDir] = process.argv.slice(2);
const child = spawn(
  "pi",
  [
    "--mode",
    "rpc",
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.6-luna",
    "--thinking",
    "low",
    "--no-extensions",
    "-e",
    "/tmp/resin-fixture-pi-mcp/rewind.ts",
    "--session-dir",
    sessionDir,
  ],
  { cwd, stdio: ["pipe", "pipe", "inherit"] },
);
const waiters = [];
let n = 0;
createInterface({ input: child.stdout }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  for (const w of [...waiters])
    if (w.match(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
});
const waitFor = (match) => {
  const r = Promise.withResolvers();
  waiters.push({ match, resolve: r.resolve });
  return r.promise;
};
const send = (cmd) => {
  const id = `p${++n}`;
  const r = waitFor((m) => m.type === "response" && m.id === id);
  child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
  return r;
};
const prompt = async (message) => {
  const end = waitFor((m) => m.type === "agent_end");
  await send({ type: "prompt", message });
  await end;
};
await prompt("Use the bash tool to run `cat README.md`. Reply with the first word only.");
await prompt("Use the bash tool to run `wc -l greet.sh`. Reply with the number only.");
const target = (await send({ type: "get_fork_messages" })).data.messages.at(-1);
await send({ type: "prompt", message: `/rewind-plain ${target.entryId}` });
await new Promise((r) => setTimeout(r, 1500));
await prompt("Use the bash tool to run `ls`. Reply with the file count only.");
child.kill();
