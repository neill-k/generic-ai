/**
 * Live events for the dashboard. The company runtime publishes what happens
 * (a task starts, delegates, finishes; the CEO answers in a thread) and the
 * API streams it to browsers over server-sent events.
 *
 * The hub keeps a short ring buffer so a reconnecting browser can resume from
 * `Last-Event-ID`. It is per process: with more than one worker process,
 * each streams the events of the turns it runs, and clients refetch state on
 * reconnect.
 */
export type CompanyEventType =
  | "task.submitted"
  | "task.started"
  | "task.delegated"
  | "task.requeued"
  | "task.resumed"
  | "task.succeeded"
  | "task.failed"
  | "task.cancelled"
  | "task.awaiting_approval"
  | "tool.effect.replayed"
  | "tool.effect.uncertain"
  | "thread.updated"
  | "drive.updated"
  | "drive.goal.updated"
  | "runtime.error";

export interface CompanyEvent {
  /** Monotonic per process. */
  readonly id: number;
  readonly type: CompanyEventType;
  readonly at: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type CompanyEventListener = (event: CompanyEvent) => void;

export interface CompanyEventHub {
  publish(type: CompanyEventType, data: Readonly<Record<string, unknown>>): CompanyEvent;
  subscribe(listener: CompanyEventListener): () => void;
  /** Buffered events after `id`, oldest first. */
  since(id: number): readonly CompanyEvent[];
  readonly lastId: number;
}

export function createCompanyEventHub(
  options: { readonly bufferSize?: number; readonly now?: () => Date } = {},
): CompanyEventHub {
  const bufferSize = options.bufferSize ?? 500;
  const now = options.now ?? (() => new Date());
  const buffer: CompanyEvent[] = [];
  const listeners = new Set<CompanyEventListener>();
  let lastId = 0;

  return {
    publish(type, data) {
      lastId += 1;
      const event: CompanyEvent = Object.freeze({
        id: lastId,
        type,
        at: now().toISOString(),
        data,
      });
      buffer.push(event);
      if (buffer.length > bufferSize) {
        buffer.splice(0, buffer.length - bufferSize);
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    since(id) {
      return buffer.filter((event) => event.id > id);
    },
    get lastId() {
      return lastId;
    },
  };
}
