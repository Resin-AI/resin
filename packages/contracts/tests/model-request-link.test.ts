import { describe, expect, it } from "vitest";
import {
  RESIN_INVOCATION_RECEIPT_META_KEY,
  formatResinInvocationReceiptText,
  isResinGatewayToolCall,
  parseResinInvocationReceiptText,
  readRequestLinkMetadata,
  readResinInvocationReceipt,
  readResinInvocationReceipts,
  resinInvocationReceiptMeta,
  resinInvocationReceiptMetadata,
} from "../src/model-request-link.js";

const FIRST = "inv_0123456789abcdef0123456789abcdef";
const SECOND = "inv_fedcba9876543210fedcba9876543210";

describe("Resin invocation receipts", () => {
  it("round-trips the canonical text part and _meta value", () => {
    const receipt = { invocationId: FIRST, benchmarkId: "bench-1" };
    const text = formatResinInvocationReceiptText(receipt);
    expect(text).toBe(`{"resinInvocationId":"${FIRST}","benchmarkId":"bench-1"}`);
    expect(parseResinInvocationReceiptText(text)).toEqual(receipt);
    expect(resinInvocationReceiptMeta(receipt)).toEqual({
      version: 1,
      invocationId: FIRST,
      benchmarkId: "bench-1",
    });
  });

  it("accepts only exact canonical text", () => {
    expect(parseResinInvocationReceiptText(`{"resinInvocationId": "${FIRST}"}`)).toBeUndefined();
    expect(
      parseResinInvocationReceiptText(`{"benchmarkId":"b","resinInvocationId":"${FIRST}"}`),
    ).toBeUndefined();
    expect(parseResinInvocationReceiptText(`{"resinInvocationId":"inv_short"}`)).toBeUndefined();
    expect(
      parseResinInvocationReceiptText(`{"resinInvocationId":"${FIRST}","extra":1}`),
    ).toBeUndefined();
  });

  it("reads a single-run result from _meta and its trailing text part when they agree", () => {
    const receipt = { invocationId: FIRST };
    const result = {
      content: [
        { type: "text", text: "tool output" },
        { type: "text", text: formatResinInvocationReceiptText(receipt) },
      ],
      _meta: { [RESIN_INVOCATION_RECEIPT_META_KEY]: resinInvocationReceiptMeta(receipt) },
      isError: true,
    };
    expect(readResinInvocationReceipt(result)).toEqual(receipt);
    expect(
      readResinInvocationReceipts({
        ...result,
        _meta: {
          [RESIN_INVOCATION_RECEIPT_META_KEY]: resinInvocationReceiptMeta({ invocationId: SECOND }),
        },
      }),
    ).toEqual([]);
  });

  it("reads every trailing receipt of a for_each result in run order", () => {
    const content = [
      { type: "text", text: "combined output" },
      { type: "text", text: formatResinInvocationReceiptText({ invocationId: FIRST }) },
      { type: "text", text: formatResinInvocationReceiptText({ invocationId: SECOND }) },
    ];
    expect(readResinInvocationReceipts({ content })).toEqual([
      { invocationId: FIRST },
      { invocationId: SECOND },
    ]);
    expect(readResinInvocationReceipt({ content })).toBeUndefined();
    expect(resinInvocationReceiptMetadata(readResinInvocationReceipts({ content }))).toEqual({
      resinInvocationIds: [FIRST, SECOND],
    });
  });

  it("ignores receipt-shaped text that is not trailing", () => {
    const content = [
      { type: "text", text: formatResinInvocationReceiptText({ invocationId: FIRST }) },
      { type: "text", text: "output printed after it" },
    ];
    expect(readResinInvocationReceipts({ content })).toEqual([]);
    expect(
      readResinInvocationReceipts(
        `output mentioning {"resinInvocationId":"${FIRST}"}\nmore output`,
      ),
    ).toEqual([]);
  });

  it("reads trailing lines of a harness-joined text result", () => {
    expect(
      readResinInvocationReceipts(
        `tool output\n${formatResinInvocationReceiptText({ invocationId: FIRST, benchmarkId: "b1" })}`,
      ),
    ).toEqual([{ invocationId: FIRST, benchmarkId: "b1" }]);
  });
});

describe("request link metadata", () => {
  it("keeps only valid identifiers", () => {
    expect(
      readRequestLinkMetadata({
        modelRequestId: "msg_01Hq7ZtR2vKx9LmPw4NcYs8D",
        taskId: "rec0002b",
        resinInvocationId: FIRST,
        benchmarkId: "bench-1",
        other: "dropped",
      }),
    ).toEqual({
      modelRequestId: "msg_01Hq7ZtR2vKx9LmPw4NcYs8D",
      taskId: "rec0002b",
      resinInvocationId: FIRST,
      benchmarkId: "bench-1",
    });
    expect(
      readRequestLinkMetadata({
        modelRequestId: "two words",
        taskId: "",
        resinInvocationId: "inv_bad",
        benchmarkId: "-bad",
      }),
    ).toEqual({});
  });

  it("keeps an auxiliary request purpose and delegated usage evidence only when valid", () => {
    const delegated = {
      version: 1,
      inputTokens: 12,
      cachedInputTokens: 30_000,
      cacheWriteTokens: 4_000,
      outputTokens: 900,
      totalTokens: 34_912,
      costMicroUsd: 81_000,
      costProvenance: "harness_estimate",
    };
    expect(
      readRequestLinkMetadata({
        modelRequestId: "aux0001a",
        modelRequestPurpose: "cache-warm:extension-override",
        delegatedModelUsage: delegated,
      }),
    ).toEqual({
      modelRequestId: "aux0001a",
      modelRequestPurpose: "cache-warm:extension-override",
      delegatedModelUsage: delegated,
    });
    expect(
      readRequestLinkMetadata({
        modelRequestPurpose: "auto thinking",
        delegatedModelUsage: { ...delegated, extra: 1 },
      }),
    ).toEqual({});
    expect(
      readRequestLinkMetadata({ delegatedModelUsage: { version: 2, totalTokens: 1 } }),
    ).toEqual({});
  });

  it("rejects ambiguous invocation shapes", () => {
    expect(
      readRequestLinkMetadata({ resinInvocationId: FIRST, resinInvocationIds: [FIRST, SECOND] }),
    ).toEqual({});
    expect(readRequestLinkMetadata({ resinInvocationIds: [FIRST] })).toEqual({});
    expect(readRequestLinkMetadata({ resinInvocationIds: [FIRST, SECOND] })).toEqual({
      resinInvocationIds: [FIRST, SECOND],
    });
    expect(readRequestLinkMetadata(["not", "metadata"])).toEqual({});
  });

  it("recognizes Resin gateway tool names across harnesses", () => {
    expect(isResinGatewayToolCall("mcp__resin__invoke_tool")).toBe(true);
    expect(isResinGatewayToolCall("mcp__resin_invoke_tool")).toBe(true);
    expect(isResinGatewayToolCall("invoke_tool", "resin")).toBe(true);
    expect(isResinGatewayToolCall("mcp__resinous__tool")).toBe(false);
    expect(isResinGatewayToolCall("bash")).toBe(false);
  });
});
