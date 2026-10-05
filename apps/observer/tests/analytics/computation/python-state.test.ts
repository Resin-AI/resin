import { describe, expect, it } from "vitest";
import { parsePythonComputation } from "../../../src/analytics/computation/python.js";
import type {
  ComputationParseContext,
  ComputationParseLocal,
} from "../../../src/analytics/computation/types.js";

/**
 * Kernel-state classification of single Python cells (synthetic sources only): which cells change
 * nothing beyond the names they bind, which mutate earlier bindings in place (reported by name), and
 * which stay opaque and invalidate the whole kernel model.
 */

function local(source: string, context?: ComputationParseContext): ComputationParseLocal {
  return parsePythonComputation(source, context).local;
}

/** A cell that changes nothing an earlier binding can reach. */
function expectLocalOnly(result: ComputationParseLocal): void {
  expect(result.invalidatesState).toBe(false);
  expect(result.mutatedNames ?? []).toEqual([]);
}

const collectionsModule: ComputationParseContext = {
  imports: [{ names: ["collections"], source: "import collections", sourceEventId: "evt_setup" }],
};

describe("Python cells writing into containers they construct", () => {
  it("keeps nested writes into a defaultdict of dicts local", () => {
    const result = local(
      [
        "r = query('select day, src, n')",
        "from collections import defaultdict",
        "days = defaultdict(dict)",
        'for day, src, n in r["results"]: days[day][src] = n',
        "for d in sorted(days): print(d, sum(days[d].values()), days[d])",
      ].join("\n"),
      {
        definitions: [
          {
            name: "query",
            source: "def query(q):\n    return {}\n",
            references: [],
            writtenNames: [],
            sourceEventId: "evt_helper",
            programDigest: "digest",
          },
        ],
      },
    );
    expectLocalOnly(result);
    expect(result.requiredNames).toContain("query");
  });

  it("keeps appends into a module-qualified defaultdict(list) local", () => {
    const result = local(
      [
        "groups = collections.defaultdict(list)",
        "for row in _ROWS:",
        "    groups[row['key']].append((row['label'], row['count']))",
        "print(len(groups))",
      ].join("\n"),
      collectionsModule,
    );
    expectLocalOnly(result);
    expect(result.requiredNames).toEqual(expect.arrayContaining(["collections", "_ROWS"]));
  });

  it("keeps setdefault-then-append on a fresh dict local", () => {
    expectLocalOnly(
      local("index = {}\nfor k, v in _PAIRS:\n    index.setdefault(k, []).append(v)\nprint(index)"),
    );
  });

  it("keeps Counter increments and updates local", () => {
    expectLocalOnly(
      local(
        [
          "from collections import Counter",
          "words = Counter()",
          "keys = Counter()",
          "for line in _LINES:",
          "    words[line.split()[0]] += 1",
          "    keys.update(line.split())",
          "print(words.most_common(3), keys.most_common(3))",
        ].join("\n"),
      ),
    );
  });

  it("keeps writes into comprehension-built containers of fresh values local", () => {
    expectLocalOnly(
      local("buckets = {k: [] for k in _KEYS}\nfor k in _KEYS:\n    buckets[k].append(len(k))"),
    );
  });

  it("does not trust a name that only looks like a collections constructor", () => {
    const result = local("days = defaultdict(dict)\nfor day, src, n in _ROWS: days[day][src] = n", {
      definitions: [
        {
          name: "defaultdict",
          source: "def defaultdict(f):\n    return _SHARED\n",
          references: ["_SHARED"],
          writtenNames: [],
          sourceEventId: "evt_helper",
          programDigest: "digest",
        },
      ],
    });
    expect(result.invalidatesState).toBe(false);
    expect(result.mutatedNames).toEqual(expect.arrayContaining(["_ROWS"]));
  });
});

describe("Python cells mutating objects earlier cells may reach", () => {
  it("attributes a nested write through a stored earlier object to what the cell reads", () => {
    // `d[k]` is `prior` itself, so appending to it changes the earlier binding.
    const result = local("d = {}\nd['k'] = prior\nd['k'].append(1)");
    expect(result.invalidatesState).toBe(false);
    expect(result.mutatedNames).toEqual(["prior"]);
  });

  it("attributes a write below a shallow copy to the copied binding", () => {
    const result = local("copy = dict(prior)\ncopy['k'].append(1)");
    expect(result.mutatedNames).toEqual(["prior"]);
  });

  it("does not let a later rebinding in a loop make a container look fresh", () => {
    const result = local("acc = []\nfor x in _XS:\n    acc.append(x)\n    acc = prior");
    expect(result.mutatedNames).toEqual(expect.arrayContaining(["prior"]));
  });

  it("attributes in-place writes through a loop variable to everything the cell reads", () => {
    const result = local("for a in records:\n    a['family'] = classify(a)", {
      definitions: [
        {
          name: "classify",
          source: "def classify(a):\n    return 1\n",
          references: [],
          writtenNames: [],
          sourceEventId: "evt_helper",
          programDigest: "digest",
        },
      ],
    });
    expect(result.invalidatesState).toBe(false);
    expect(result.mutatedNames).toEqual(expect.arrayContaining(["records"]));
  });

  it("reports item writes and deletions on an earlier binding by name", () => {
    expect(local("seen[_KEY] = 1").mutatedNames).toEqual(["seen"]);
    expect(local("del seen[_KEY]").mutatedNames).toEqual(["seen"]);
    expect(local("total += 1").mutatedNames).toEqual(["total"]);
  });

  it("treats a module function named like a container method as a module call", () => {
    const result = local("import os\nos.remove(_PATH) if os.path.exists(_PATH) else None");
    expectLocalOnly(result);
  });
});

describe("Python cells whose effects stay opaque", () => {
  it.each([
    ["a call into unseen code", "mystery()"],
    ["namespace reflection", "globals()['x'] = 1"],
    ["dynamic execution", "exec(_SOURCE)"],
    ["deleting a name", "del rows"],
    ["a global declaration", "def bump():\n    global counter\n    counter += 1"],
    ["module state", "import os\nos.environ['MODE'] = 'x'"],
    ["module state through an attribute", "import sys\nsys.path.append(_DIR)"],
    ["an attribute write on an earlier object", "config.mode = 'x'"],
  ])("invalidates on %s", (_label, source) => {
    expect(local(source).invalidatesState).toBe(true);
  });
});

describe("Python builtins in kernel-state bookkeeping", () => {
  it("never requires or distrusts a stateless builtin", () => {
    const result = local(
      "for i, line in enumerate(_LINES):\n    print(i, tuple(line.split()), repr(line))",
    );
    expectLocalOnly(result);
    expect(result.requiredNames).toEqual(["_LINES"]);
  });

  it("treats a read-only open with text-decoding keywords as a read", () => {
    expectLocalOnly(
      local("with open(_PATH, errors='replace', encoding='utf-8') as fh:\n    data = fh.read()"),
    );
    expect(local("with open(_PATH, mode='w') as fh:\n    fh.write('x')").invalidatesState).toBe(
      true,
    );
  });
});
