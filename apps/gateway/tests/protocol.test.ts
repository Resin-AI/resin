import { describe, expect, it } from "vitest";
import {
  JSON_RPC_ERROR_CODES,
  MCP_ERROR_CODES,
  McpFrameDecoder,
  McpProtocolError,
  createMcpError,
  encodeMcpMessage,
  isMcpProtocolError,
} from "../src/protocol/index.js";
import type { JsonRpcRequest } from "../src/protocol/types.js";

describe("Protocol Framing & Decoding", () => {
  it("encodes and decodes standard newline-delimited JSON-RPC messages", () => {
    const decoder = new McpFrameDecoder();
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
    };

    const encoded = encodeMcpMessage(req);
    expect(encoded.endsWith("\n")).toBe(true);

    const decoded = decoder.push(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(req);
  });

  it("handles fragmented chunked data across multiple pushes", () => {
    const decoder = new McpFrameDecoder();
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-123",
      method: "tools/list",
      params: {},
    });

    const chunk1 = msg.slice(0, 10);
    const chunk2 = msg.slice(10, 25);
    const chunk3 = `${msg.slice(25)}\n`;

    expect(decoder.push(chunk1)).toHaveLength(0);
    expect(decoder.push(chunk2)).toHaveLength(0);
    const result = decoder.push(chunk3);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      jsonrpc: "2.0",
      id: "req-123",
      method: "tools/list",
      params: {},
    });
  });

  it("handles multiple concatenated messages in a single buffer", () => {
    const decoder = new McpFrameDecoder();
    const msg1 = { jsonrpc: "2.0", id: 1, method: "ping" };
    const msg2 = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const msg3 = { jsonrpc: "2.0", method: "notifications/initialized" };

    const payload = `${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\r\n${JSON.stringify(msg3)}\n`;
    const messages = decoder.push(payload);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(msg1);
    expect(messages[1]).toEqual(msg2);
    expect(messages[2]).toEqual(msg3);
  });

  it("decodes Content-Length header framed payloads", () => {
    const decoder = new McpFrameDecoder();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    const framed = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    const messages = decoder.push(framed);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      id: 42,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
  });

  it("throws PARSE_ERROR on malformed JSON payload", () => {
    const decoder = new McpFrameDecoder();
    expect(() => {
      decoder.push("{ malformed json line\n");
    }).toThrowError(McpProtocolError);

    try {
      decoder.push("{ another bad json\n");
    } catch (err) {
      expect(isMcpProtocolError(err)).toBe(true);
      if (isMcpProtocolError(err)) {
        expect(err.code).toBe(JSON_RPC_ERROR_CODES.PARSE_ERROR);
      }
    }
  });

  it("throws INVALID_REQUEST on non-object or invalid jsonrpc version", () => {
    const decoder = new McpFrameDecoder();
    expect(() => {
      decoder.push('["not an object"]\n');
    }).toThrowError(McpProtocolError);

    expect(() => {
      decoder.push('{"jsonrpc": "1.0", "id": 1, "method": "ping"}\n');
    }).toThrowError(McpProtocolError);

    expect(() => {
      decoder.push('{"jsonrpc": "2.0"}\n');
    }).toThrowError(McpProtocolError);
  });

  it("enforces max message size limits", () => {
    const decoder = new McpFrameDecoder({ maxMessageSizeBytes: 100 });
    const hugeMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      data: "a".repeat(200),
    });

    expect(() => {
      decoder.push(`${hugeMessage}\n`);
    }).toThrowError(McpProtocolError);

    try {
      decoder.push(`${hugeMessage}\n`);
    } catch (err) {
      if (isMcpProtocolError(err)) {
        expect(err.code).toBe(MCP_ERROR_CODES.OVERSIZED_REQUEST);
      }
    }
  });

  it("creates and inspects McpProtocolError properly", () => {
    const err = createMcpError(MCP_ERROR_CODES.TOOL_NOT_FOUND, "Tool not found", {
      toolName: "nonexistent",
    });
    expect(err.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
    expect(err.message).toBe("Tool not found");
    expect(err.data).toEqual({ toolName: "nonexistent" });
    expect(err.toJsonRpcError()).toEqual({
      code: MCP_ERROR_CODES.TOOL_NOT_FOUND,
      message: "Tool not found",
      data: { toolName: "nonexistent" },
    });
    expect(isMcpProtocolError(err)).toBe(true);
  });
});
