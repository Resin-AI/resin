import { describe, expect, it } from "vitest";
import {
  scriptRecordFieldKeys,
  scriptTokenContextName,
  tokenizeProgram,
} from "../src/program-tokens.js";

type Language = "python" | "javascript";

function fieldValues(language: Language, source: string) {
  const tokens = tokenizeProgram(language, source);
  return [...scriptRecordFieldKeys(source, tokens)].map((index) => tokens[index]!.value).sort();
}

/** The context name of the first string or number literal whose value is `value`. */
function nameOf(language: Language, source: string, value: string | number) {
  const tokens = tokenizeProgram(language, source);
  const index = tokens.findIndex(
    (token) => (token.kind === "string" || token.kind === "number") && token.value === value,
  );
  if (index < 0) throw new Error(`no literal ${String(value)}`);
  return scriptTokenContextName(source, tokens, index);
}

describe("scriptRecordFieldKeys", () => {
  it("treats keys a record is subscripted with as fields, but not a lone subscript", () => {
    expect(
      fieldValues("python", "t=[x for x in p if x['merchant']=='B' and x['year']=='2023']"),
    ).toEqual(["merchant", "year"]);
    expect(fieldValues("python", "print(d['alpha'])")).toEqual([]);
    expect(fieldValues("javascript", "const v = r['a'] + r['b'];")).toEqual(["a", "b"]);
  });

  it("treats keys of a dict with two string keys as fields, but not a one-key dict", () => {
    expect(fieldValues("python", "q={'region': 'emea', 'month': '03'}")).toEqual([
      "month",
      "region",
    ]);
    expect(fieldValues("python", "q={'region': 'emea'}")).toEqual([]);
    expect(fieldValues("javascript", "const q = {'region': 'emea', 'month': '03'};")).toEqual([
      "month",
      "region",
    ]);
  });
});

describe("scriptTokenContextName", () => {
  const RECORD = "t=[x for x in p if x['merchant']=='Belles' and '12'==x['day_of_year']]";

  it("names a value after the record field it is compared with, on either side", () => {
    expect(nameOf("python", RECORD, "Belles")).toBe("merchant");
    expect(nameOf("python", RECORD, "12")).toBe("day_of_year");
    expect(
      nameOf("javascript", "rows.filter((r) => r['city'] === 'Oslo' || r['zip'] !== '1')", "Oslo"),
    ).toBe("city");
    expect(nameOf("javascript", "if ('1' !== r['zip'] && r['city']) {}", "1")).toBe("zip");
  });

  it("names a value after the identifier it is compared with or assigned to", () => {
    expect(nameOf("python", "if region == 'emea': pass", "emea")).toBe("region");
    expect(nameOf("python", "if 'emea' != Region: pass", "emea")).toBe("region");
    expect(nameOf("python", "run(target_month='03')", "03")).toBe("target_month");
    expect(nameOf("javascript", "const storeName = 'Belles';", "Belles")).toBe("storename");
    expect(nameOf("javascript", "let limit = 25;", 25)).toBe("limit");
  });

  it("names a dict entry after its key", () => {
    expect(nameOf("python", "q={'Store-Name': 'Belles', 'month': '03'}", "Belles")).toBe(
      "store_name",
    );
  });

  it("never names from keywords, single letters, or the value itself", () => {
    expect(nameOf("python", "ok = x is 'emea'", "emea")).toBe(undefined);
    expect(nameOf("python", "if x == 'emea': pass", "emea")).toBe(undefined);
    expect(nameOf("python", "print('emea')", "emea")).toBe(undefined);
    expect(nameOf("javascript", "if (this == 'emea') {}", "emea")).toBe(undefined);
    expect(nameOf("python", "d={'region': 'emea'}", "emea")).toBe(undefined);
  });
});
