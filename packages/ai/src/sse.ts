/**
 * Minimal server-sent events decoder for providers that stream over raw `fetch`. Handles events and
 * UTF-8 sequences split across transport chunks, CRLF line endings, comments and multi-line data.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export class SseDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | undefined;

  /** Feed a transport chunk; returns the events it completed. */
  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** Flush at end of stream; returns any final event. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let newline = this.buffer.search(/\r\n|\r|\n/);
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith("\r\n", newline) ? 2 : 1;
      // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
      if (
        !final &&
        width === 1 &&
        this.buffer[newline] === "\r" &&
        newline === this.buffer.length - 1
      ) {
        break;
      }
      this.buffer = this.buffer.slice(newline + width);
      this.line(line, events);
      newline = this.buffer.search(/\r\n|\r|\n/);
    }
    if (final) {
      if (this.buffer.length > 0) {
        this.line(this.buffer, events);
        this.buffer = "";
      }
      this.dispatch(events);
    }
    return events;
  }

  private line(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "event") {
      this.eventName = value;
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (this.dataLines.length > 0) {
      events.push({
        ...(this.eventName !== undefined ? { event: this.eventName } : {}),
        data: this.dataLines.join("\n"),
      });
    }
    this.dataLines = [];
    this.eventName = undefined;
  }
}

/** Read a response body as SSE events, cancelling the reader when `signal` aborts. */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const sse = new SseDecoder();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Request was aborted");
      }
      for (const event of done ? sse.end() : sse.push(value)) {
        yield event;
      }
      if (done) {
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}
