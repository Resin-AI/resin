import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ListingFootprint,
  type ListingFootprintRecord,
  ListingFootprintRecordSchema,
  canonicalJson,
} from "@resin/contracts";

/**
 * Ties a session to the Resin MCP surface it was served, from the local records each `resin mcp`
 * process writes (see `ListingFootprintRecordSchema`). The join is exact, never fuzzy: a record is a
 * candidate when it served the session's harness in the session's directory and was running when
 * the session's first prompt was sent; the footprint is known only when every candidate had served
 * the same surface by then. Anything else is unknown (undefined). Records are only read.
 */
export class ListingFootprintJoin {
  private readonly directory: string;

  constructor(options: { directory: string }) {
    this.directory = options.directory;
  }

  /** The footprint the session's harness was served at `at` in `sessionDirectory`, or undefined. */
  footprintFor(input: {
    harnessId: string | undefined;
    sessionDirectory: string | undefined;
    at: string;
  }): ListingFootprint | undefined {
    const { harnessId, sessionDirectory } = input;
    if (!harnessId || !sessionDirectory) return undefined;
    const at = Date.parse(input.at);
    if (Number.isNaN(at)) return undefined;

    const sessionPath = directoryForms(sessionDirectory);
    let effective: ListingFootprint | undefined;
    let effectiveJson: string | undefined;
    for (const record of this.readRecords()) {
      if (record.harnessId !== harnessId) continue;
      if (Date.parse(record.startedAt) > at) continue;
      const recordPath = directoryForms(record.cwd);
      // Equal when the resolved paths match, or when both resolve to the same real path.
      if (
        recordPath.resolved !== sessionPath.resolved &&
        (sessionPath.real === undefined || recordPath.real !== sessionPath.real)
      ) {
        continue;
      }
      if (record.closedAt !== undefined && at > Date.parse(record.closedAt)) continue;
      const served = record.surfaces.filter((surface) => Date.parse(surface.servedAt) <= at).at(-1);
      // A candidate that had served nothing yet makes the session's surface unknown.
      if (served === undefined) return undefined;
      const servedJson = canonicalJson(served.footprint);
      if (effectiveJson !== undefined && servedJson !== effectiveJson) return undefined;
      effective = served.footprint;
      effectiveJson = servedJson;
    }
    return effective;
  }

  private readRecords(): ListingFootprintRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }
    const records: ListingFootprintRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = ListingFootprintRecordSchema.safeParse(
          JSON.parse(fs.readFileSync(path.join(this.directory, name), "utf8")),
        );
        if (parsed.success) records.push(parsed.data);
      } catch {
        // Unreadable or partially written records are not candidates.
      }
    }
    return records;
  }
}

interface DirectoryForms {
  resolved: string;
  real: string | undefined;
}

function directoryForms(directory: string): DirectoryForms {
  const resolved = path.resolve(directory);
  let real: string | undefined;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    real = undefined;
  }
  return { resolved, real };
}
