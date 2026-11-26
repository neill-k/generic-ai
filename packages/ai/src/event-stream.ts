import type { AssistantMessage, AssistantMessageEvent } from "./types.js";

/** Amortised O(1) FIFO built from two stacks. */
class FifoQueue<T> {
  #incoming: T[] = [];
  #outgoing: T[] = [];

  get length(): number {
    return this.#incoming.length + this.#outgoing.length;
  }

  enqueue(value: T): void {
    this.#incoming.push(value);
  }

  dequeue(): T | undefined {
    if (this.#outgoing.length === 0) {
      while (this.#incoming.length > 0) {
        this.#outgoing.push(this.#incoming.pop() as T);
      }
    }
    return this.#outgoing.pop();
  }
}

/**
 * Push-based async iterable with a final result.
 *
 * Events pushed before anyone iterates are buffered. The stream completes when `isComplete(event)`
 * is true (the result is `extractResult(event)`) or when `end()` is called. Events pushed after
 * completion are ignored. Each event is delivered to exactly one consumer.
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  readonly #queue = new FifoQueue<T>();
  readonly #waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
  readonly #isComplete: (event: T) => boolean;
  readonly #extractResult: (event: T) => R;
  readonly #result: Promise<R>;
  #resolveResult!: (result: R) => void;
  protected done = false;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.#isComplete = isComplete;
    this.#extractResult = extractResult;
    this.#result = new Promise<R>((resolve) => {
      this.#resolveResult = resolve;
    });
  }

  get isDone(): boolean {
    return this.done;
  }

  push(event: T): void {
    if (this.done) {
      return;
    }
    if (this.#isComplete(event)) {
      this.done = true;
      this.#resolveResult(this.#extractResult(event));
    }
    const waiter = this.#waiting.dequeue();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.#queue.enqueue(event);
    }
    if (this.done) {
      this.#wakeAll();
    }
  }

  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.#resolveResult(result);
    }
    this.#wakeAll();
  }

  #wakeAll(): void {
    // Waiters exist only while the buffer is empty, so every one of them is done now.
    while (this.#waiting.length > 0 && this.#queue.length === 0) {
      const waiter = this.#waiting.dequeue();
      waiter?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.#queue.length > 0) {
        yield this.#queue.dequeue() as T;
        continue;
      }
      if (this.done) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) =>
        this.#waiting.enqueue(resolve),
      );
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  result(): Promise<R> {
    return this.#result;
  }
}

/**
 * Event stream of one assistant response. The final message gets `durationMs`, measured with a
 * monotonic clock from the stream's creation, unless it already has one or its `timestamp`
 * predates the stream (a forwarded response that started elsewhere).
 */
export class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  readonly #startedAt = Date.now();
  readonly #startedAtMonotonic = performance.now();

  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        }
        if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected terminal event");
      },
    );
  }

  override push(event: AssistantMessageEvent): void {
    if (!this.done) {
      if (event.type === "done") {
        this.#time(event.message);
      } else if (event.type === "error") {
        this.#time(event.error);
      }
    }
    super.push(event);
  }

  override end(result?: AssistantMessage): void {
    if (!this.done && result) {
      this.#time(result);
    }
    super.end(result);
  }

  #time(message: AssistantMessage): void {
    if (message.durationMs !== undefined || message.timestamp < this.#startedAt) {
      return;
    }
    message.durationMs = Math.round(performance.now() - this.#startedAtMonotonic);
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}
