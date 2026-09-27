/**
 * Registry qualification convention (apps/observer/tests/harness-qualification.test.ts). Cursor
 * has no tested versions: cursor-agent needs a login before any hook fires, so nothing was
 * recorded. This feeds the synthetic hook payloads from ./helpers through the real installed
 * capture hook into `home`, so the capture path is still qualified.
 */
import { conversationPayloads, installedHook } from "./helpers.js";

export async function materializeRecordedHomes(
  _version: string | undefined,
  createHome: () => string,
): Promise<void> {
  const home = createHome();
  const run = await installedHook(home);
  const payloads = [
    ...conversationPayloads({
      conversationId: "qualify-parent",
      workspace: "/workspace/project",
      subagentId: "qualify-child",
    }),
    ...conversationPayloads({ conversationId: "qualify-child", workspace: "/workspace/project" }),
  ];
  for (const payload of payloads) run(payload);
}
