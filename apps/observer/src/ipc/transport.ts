import { EventEmitter } from "node:events";

export interface IpcTransport {
  send(data: Buffer): Promise<void>;
  onData(handler: (data: Buffer) => void): void;
  onError(handler: (err: Error) => void): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
  readonly isClosed: boolean;
}

/**
 * In-memory bidirectional transport pair for testing without Unix domain sockets.
 */
export class InMemoryIpcTransport implements IpcTransport {
  private peer: InMemoryIpcTransport | null = null;
  private emitter = new EventEmitter();
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  setPeer(peer: InMemoryIpcTransport): void {
    this.peer = peer;
  }

  async send(data: Buffer): Promise<void> {
    if (this.closed || !this.peer || this.peer.isClosed) {
      throw new Error("Cannot send data on a closed transport");
    }

    const peer = this.peer;
    const copy = Buffer.from(data);
    queueMicrotask(() => {
      if (!peer.isClosed) {
        peer.receive(copy);
      }
    });
  }

  receive(data: Buffer): void {
    if (!this.closed) {
      this.emitter.emit("data", data);
    }
  }

  onData(handler: (data: Buffer) => void): void {
    this.emitter.on("data", handler);
  }

  onError(handler: (err: Error) => void): void {
    this.emitter.on("error", handler);
  }

  onClose(handler: () => void): void {
    this.emitter.on("close", handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emitter.emit("close");

    if (this.peer && !this.peer.isClosed) {
      const peer = this.peer;
      this.peer = null;
      queueMicrotask(() => {
        void peer.close();
      });
    } else {
      this.peer = null;
    }
  }
}

/**
 * Creates a connected pair of in-memory transports for testing.
 */
export function createInMemoryIpcPair(): {
  serverTransport: InMemoryIpcTransport;
  clientTransport: InMemoryIpcTransport;
} {
  const serverTransport = new InMemoryIpcTransport();
  const clientTransport = new InMemoryIpcTransport();

  serverTransport.setPeer(clientTransport);
  clientTransport.setPeer(serverTransport);

  return { serverTransport, clientTransport };
}
