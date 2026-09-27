import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [cwd, sessionDir, session] = process.argv.slice(2);
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
    "--session-dir",
    sessionDir,
    "--session",
    session,
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
  const id = `c${++n}`;
  const r = waitFor((m) => m.type === "response" && m.id === id);
  child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
  return r;
};
console.error(JSON.stringify(await send({ type: "compact" })).slice(0, 300));
const end = waitFor((m) => m.type === "agent_end");
await send({ type: "prompt", message: "After compaction: reply with just OK." });
await end;
child.kill();
