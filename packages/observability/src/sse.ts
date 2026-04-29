import type { JsonObject } from "@generic-ai/sdk";

export interface ObservabilityLiveEvent {
  readonly id: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: string;
  readonly data: JsonObject;
}

export interface ObservabilityLiveEventBusOptions {
  readonly historyLimit?: number;
  readonly maxSubscriberQueue?: number;
  readonly now?: () => string;
  readonly onDisconnect?: (reason: "closed" | "slow_consumer") => void;
}

export interface ObservabilityLiveEventSubscription {
  readonly id: string;
  readonly closed: boolean;
  close(): void;
}

export interface ObservabilityLiveEventBus {
  publish(type: string, data: JsonObject): ObservabilityLiveEvent;
  snapshot(options?: { readonly fromSequence?: number }): readonly ObservabilityLiveEvent[];
  subscribe(
    listener: (event: ObservabilityLiveEvent) => void,
    options?: { readonly fromSequence?: number },
  ): ObservabilityLiveEventSubscription;
  toSseResponse(request: Request, options?: { readonly fromSequence?: number }): Response;
  close(): void;
}

interface Subscriber {
  readonly id: string;
  readonly listener: (event: ObservabilityLiveEvent) => void;
  queued: number;
}

export function createObservabilityLiveEventBus(
  options: ObservabilityLiveEventBusOptions = {},
): ObservabilityLiveEventBus {
  const historyLimit = options.historyLimit ?? 500;
  const maxSubscriberQueue = options.maxSubscriberQueue ?? 64;
  const subscribers = new Map<string, Subscriber>();
  const history: ObservabilityLiveEvent[] = [];
  const now = options.now ?? (() => new Date().toISOString());
  let nextSequence = 1;
  let nextSubscriberId = 1;
  let closed = false;

  function snapshot(input: { readonly fromSequence?: number } = {}): readonly ObservabilityLiveEvent[] {
    return Object.freeze(
      history.filter((event) =>
        input.fromSequence === undefined ? true : event.sequence >= input.fromSequence,
      ),
    );
  }

  function closeSubscriber(id: string, reason: "closed" | "slow_consumer"): void {
    if (subscribers.delete(id)) {
      options.onDisconnect?.(reason);
    }
  }

  function subscribeToBus(
    listener: (event: ObservabilityLiveEvent) => void,
    input: { readonly fromSequence?: number } = {},
  ): ObservabilityLiveEventSubscription {
    if (closed) {
      throw new Error("Cannot subscribe to a closed observability event bus.");
    }

    const id = `obs-subscription-${nextSubscriberId++}`;
    for (const event of snapshot(input)) {
      listener(event);
    }
    subscribers.set(id, { id, listener, queued: 0 });

    return {
      id,
      get closed() {
        return !subscribers.has(id);
      },
      close() {
        closeSubscriber(id, "closed");
      },
    };
  }

  return {
    publish(type: string, data: JsonObject): ObservabilityLiveEvent {
      if (closed) {
        throw new Error("Cannot publish to a closed observability event bus.");
      }

      const event = Object.freeze({
        id: `obs-live-${nextSequence}`,
        sequence: nextSequence++,
        occurredAt: now(),
        type,
        data: Object.freeze({ ...data }),
      });
      history.push(event);
      if (history.length > historyLimit) {
        history.splice(0, history.length - historyLimit);
      }

      for (const subscriber of subscribers.values()) {
        subscriber.queued += 1;
        if (subscriber.queued > maxSubscriberQueue) {
          closeSubscriber(subscriber.id, "slow_consumer");
          continue;
        }

        try {
          subscriber.listener(event);
        } finally {
          subscriber.queued -= 1;
        }
      }

      return event;
    },

    snapshot,

    subscribe: subscribeToBus,

    toSseResponse(request: Request, input: { readonly fromSequence?: number } = {}): Response {
      const encoder = new TextEncoder();
      let subscription: ObservabilityLiveEventSubscription | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (event: ObservabilityLiveEvent) => {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              subscription?.close();
              return;
            }

            controller.enqueue(encoder.encode(formatSseEvent(event)));
          };
          subscription = subscribeToBus(write, input);
          request.signal.addEventListener("abort", () => {
            subscription?.close();
            try {
              controller.close();
            } catch {
              // The client may have already closed the stream.
            }
          });
        },
        cancel() {
          subscription?.close();
        },
      });

      return new Response(stream, {
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        },
      });
    },

    close() {
      closed = true;
      for (const id of subscribers.keys()) {
        closeSubscriber(id, "closed");
      }
      history.splice(0, history.length);
    },
  };
}

function formatSseEvent(event: ObservabilityLiveEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}
