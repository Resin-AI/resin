import { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES, McpProtocolError } from "./errors.js";
import type { JsonRpcMessage } from "./types.js";

export interface FrameDecoderOptions {
  maxMessageSizeBytes?: number;
}

const DEFAULT_MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Robust JSON-RPC 2.0 Framing Decoder for MCP stdio and IPC transports.
 * Supports newline-delimited JSON and Content-Length framed payloads.
 */
export class McpFrameDecoder {
  private buffer = "";
  private readonly maxMessageSize: number;

  constructor(options: FrameDecoderOptions = {}) {
    this.maxMessageSize = options.maxMessageSizeBytes ?? DEFAULT_MAX_MESSAGE_SIZE;
  }

  /**
   * Push incoming data chunk and extract any complete JSON-RPC messages.
   */
  push(chunk: Buffer | string): JsonRpcMessage[] {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buffer += text;

    if (this.buffer.length > this.maxMessageSize * 2) {
      this.buffer = "";
      throw new McpProtocolError(
        MCP_ERROR_CODES.OVERSIZED_REQUEST,
        `Incoming payload buffer exceeded maximum limit of ${this.maxMessageSize} bytes`,
      );
    }

    const messages: JsonRpcMessage[] = [];

    while (this.buffer.length > 0) {
      this.buffer = this.buffer.trimStart();
      if (this.buffer.length === 0) break;

      // Case 1: Check for Content-Length header framing
      if (this.buffer.startsWith("Content-Length:") || this.buffer.startsWith("content-length:")) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        const altHeaderEnd = headerEnd === -1 ? this.buffer.indexOf("\n\n") : -1;
        const separatorIndex = headerEnd !== -1 ? headerEnd : altHeaderEnd;
        const separatorLength = headerEnd !== -1 ? 4 : 2;

        if (separatorIndex === -1) {
          // Incomplete headers
          if (this.buffer.length > 4096) {
            this.buffer = "";
            throw new McpProtocolError(JSON_RPC_ERROR_CODES.PARSE_ERROR, "Malformed header block");
          }
          break;
        }

        const headerPart = this.buffer.slice(0, separatorIndex);
        const match = /content-length:\s*(\d+)/i.exec(headerPart);
        if (!match) {
          this.buffer = "";
          throw new McpProtocolError(
            JSON_RPC_ERROR_CODES.PARSE_ERROR,
            "Invalid Content-Length header",
          );
        }

        const contentLength = Number.parseInt(match[1], 10);
        if (contentLength > this.maxMessageSize) {
          this.buffer = "";
          throw new McpProtocolError(
            MCP_ERROR_CODES.OVERSIZED_REQUEST,
            `Content-Length ${contentLength} exceeds limit of ${this.maxMessageSize} bytes`,
          );
        }

        const bodyStart = separatorIndex + separatorLength;
        if (this.buffer.length < bodyStart + contentLength) {
          // Wait for full body
          break;
        }

        const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
        this.buffer = this.buffer.slice(bodyStart + contentLength);
        messages.push(this.parseJsonMessage(body));
        continue;
      }

      // Case 2: Newline-delimited JSON line
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        // No full line yet; check size limit
        if (this.buffer.length > this.maxMessageSize) {
          this.buffer = "";
          throw new McpProtocolError(
            MCP_ERROR_CODES.OVERSIZED_REQUEST,
            `Unterminated message line exceeds limit of ${this.maxMessageSize} bytes`,
          );
        }
        break;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      if (line.length > this.maxMessageSize) {
        throw new McpProtocolError(
          MCP_ERROR_CODES.OVERSIZED_REQUEST,
          `Message length ${line.length} exceeds limit of ${this.maxMessageSize} bytes`,
        );
      }

      messages.push(this.parseJsonMessage(line));
    }

    return messages;
  }

  /**
   * Resets internal buffer state.
   */
  reset(): void {
    this.buffer = "";
  }

  /**
   * Parses and validates a JSON string into a JsonRpcMessage.
   */
  parseJsonMessage(rawJson: string): JsonRpcMessage {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.PARSE_ERROR,
        `Malformed JSON: ${(err as Error).message}`,
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "JSON-RPC 2.0 payload must be a JSON object",
      );
    }

    const obj = parsed as Record<string, unknown>;
    if (obj.jsonrpc !== "2.0") {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "Invalid or missing 'jsonrpc': '2.0' attribute",
      );
    }

    // Must be either a request/notification (has string method) or a response (has id + result or error)
    const hasMethod = typeof obj.method === "string";
    const hasResult = "result" in obj;
    const hasError = "error" in obj;
    const hasId = "id" in obj;

    if (!hasMethod && !hasResult && !hasError) {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "Message must contain either 'method', 'result', or 'error'",
      );
    }

    if (hasId) {
      const id = obj.id;
      if (typeof id !== "string" && typeof id !== "number" && id !== null) {
        throw new McpProtocolError(
          JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          "Message 'id' must be a string, number, or null",
        );
      }
    }

    return obj as unknown as JsonRpcMessage;
  }
}

/**
 * Formats a JSON-RPC message as a newline-delimited JSON string for stdio/IPC transmission.
 */
export function encodeMcpMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
