/**
 * A real OpenCode 1.18.32 session (adapters/opencode/tests/fixtures/recorded/1.18.32/
 * csv-report-db.jsonl): a CSV count report built with `tail | cut | sort | uniq -c` into a file.
 * Its built-in `bash` calls reach the cloud as scrubbed program views with role-named inputs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpencodeRecordDecoder,
  OpencodeSessionEventSource,
  OpencodeSqliteStore,
} from "@resin/adapter-opencode";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drain, rebuildSqliteStore } from "../../../../adapters/opencode/tests/helpers.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
} from "../../src/analytics/workflow-call-recorder.js";
import { readWorkflowCallCarrier } from "../../src/analytics/workflow-carrier.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const EXPORT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../adapters/opencode/tests/fixtures/recorded/1.18.32/csv-report-db.jsonl",
);
const SESSION = "ses_f19f661f4ffey02KX6HUoa2gMu";
const WORKSPACE = "workspace-opencode-tool-capture";

let dir: string;
let store: OpencodeSqliteStore;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-opencode-capture-"));
  const dbPath = path.join(dir, "opencode.db");
  rebuildSqliteStore(dbPath, EXPORT);
  store = new OpencodeSqliteStore(dbPath);
});

afterAll(() => {
  store.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function capture(): Promise<NormalizedSessionEvent[]> {
  const source = new OpencodeSessionEventSource(store, {
    sessionId: SESSION,
    workspaceId: WORKSPACE,
    harnessId: "opencode",
    transcriptPath: store.location,
    status: "idle",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    metadata: {},
  });
  const records = await drain(source);
  await source.close();
  const privateValues = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: privateValues });
  pipeline.registerDecoder(new OpencodeRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues });
  const observed: NormalizedSessionEvent[] = [];
  for (const record of records) {
    for (const result of await pipeline.processRecord(record, {
      sessionId: SESSION,
      harnessId: "opencode",
      workspaceId: WORKSPACE,
    })) {
      expect(result.status).toBe("success");
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  return observed;
}

describe("OpenCode tool capture", () => {
  it("shares each built-in bash command as a program view with role-named inputs", async () => {
    const carriers = (await capture()).flatMap((event) =>
      event.type === "tool_call" && event.toolName === "bash"
        ? [readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])]
        : [],
    );
    expect(
      carriers.map((carrier) => {
        const origin = carrier?.origins?.command;
        return origin?.type === "program" && origin.source.type === "literal"
          ? origin.source.value
          : origin?.type;
      }),
    ).toEqual([
      "ls -la && head -5 sales.csv",
      "tail -n +2 sales.csv | cut -d, -f1 | sort | uniq -c > region-report.txt",
      "cat region-report.txt",
    ]);
    const names = carriers.flatMap((carrier) =>
      (carrier?.candidates ?? []).flatMap((candidate) =>
        candidate.proposed.kind === "input" ? [candidate.proposed.name] : [],
      ),
    );
    // `sales.csv` is data and `region-report.txt` a document in every call that uses them.
    expect(names).toEqual(["data_path", "text", "data_path", "document_path", "document_path"]);
  });
});
