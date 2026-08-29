export const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB max frame size
const HEADER_SIZE = 4;

/**
 * Encodes a JSON-serializable message into a length-prefixed binary frame.
 */
export function encodeFrame<T>(message: T): Buffer {
  const jsonString = JSON.stringify(message);
  const payload = Buffer.from(jsonString, "utf-8");

  if (payload.length > MAX_FRAME_SIZE) {
    throw new Error(
      `Frame payload size (${payload.length} bytes) exceeds maximum allowable size (${MAX_FRAME_SIZE} bytes)`,
    );
  }

  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, HEADER_SIZE);

  return frame;
}

/**
 * Stateful stream decoder that accumulates incoming chunks and extracts length-prefixed JSON frames.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Pushes a new data chunk and yields all completely decoded frames.
   */
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];

    while (this.buffer.length >= HEADER_SIZE) {
      const payloadLength = this.buffer.readUInt32BE(0);

      if (payloadLength > MAX_FRAME_SIZE) {
        this.buffer = Buffer.alloc(0);
        throw new Error(
          `Incoming frame size (${payloadLength} bytes) exceeds limit (${MAX_FRAME_SIZE} bytes)`,
        );
      }

      const totalFrameSize = HEADER_SIZE + payloadLength;
      if (this.buffer.length < totalFrameSize) {
        // Incomplete frame, wait for more chunks
        break;
      }

      const payloadBuffer = this.buffer.subarray(HEADER_SIZE, totalFrameSize);
      this.buffer = this.buffer.subarray(totalFrameSize);

      try {
        const jsonStr = payloadBuffer.toString("utf-8");
        const parsed = JSON.parse(jsonStr);
        frames.push(parsed);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to decode JSON frame: ${errorMsg}`);
      }
    }

    return frames;
  }

  /**
   * Clears internal buffer.
   */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
