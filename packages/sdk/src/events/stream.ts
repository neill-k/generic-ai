import {
  createCanonicalEvent,
  getCanonicalEventFamily,
  type CanonicalEvent,
  type CanonicalEventFamily,
  type CanonicalEventInput,
  type CanonicalEventName,
  type CanonicalEventOriginNamespace,
  type CanonicalEventData,
} from "./taxonomy.js";

export interface CanonicalEventSubscriptionFilter {
  readonly names?: readonly CanonicalEventName[];
  readonly families?: readonly CanonicalEventFamily[];
  readonly namespaces?: readonly CanonicalEventOriginNamespace[];
  readonly pluginId?: string;
  readonly fromSequence?: number;
  readonly predicate?: (event: CanonicalEvent) => boolean;
}

export interface CanonicalEventSubscription {
  readonly id: string;
  readonly closed: boolean;
  close(): void;
}

export interface CanonicalEventStreamOptions {
  readonly historyLimit?: number;
  readonly createEventId?: () => string;
  readonly now?: () => string;
  readonly onSubscriberError?: (
    error: unknown,
    event: CanonicalEvent,
    subscriptionId: string,
  ) => void;
}

export type CanonicalEventListener<TEvent extends CanonicalEvent = CanonicalEvent> = (
  event: TEvent,
) => void | Promise<void>;

export interface CanonicalEventStream {
  readonly closed: boolean;
  emit<TName extends CanonicalEventName, TData extends CanonicalEventData = CanonicalEventData>(
    event: CanonicalEventInput<TName, TData>,
  ): Promise<CanonicalEvent<TName, TData>>;
  subscribe<TEvent extends CanonicalEvent = CanonicalEvent>(
    listener: CanonicalEventListener<TEvent>,
    filter?: CanonicalEventSubscriptionFilter,
  ): Promise<CanonicalEventSubscription>;
  snapshot(
    filter?: Pick<CanonicalEventSubscriptionFilter, "fromSequence">,
  ): readonly CanonicalEvent[];
  close(): void;
}

export function createCanonicalEventStream(
  options: CanonicalEventStreamOptions = {},
): CanonicalEventStream {
  const listeners = new Map<
    string,
    { listener: CanonicalEventListener; filter?: CanonicalEventSubscriptionFilter }
  >();
  const history: CanonicalEvent[] = [];
  let closed = false;
  let nextSequence = 1;
  let nextSubscriptionId = 1;

  function matchesFilter(
    event: CanonicalEvent,
    filter?: CanonicalEventSubscriptionFilter,
  ): boolean {
    if (!filter) {
      return true;
    }

    if (filter.fromSequence !== undefined && event.sequence < filter.fromSequence) {
      return false;
    }

    if (filter.names && !filter.names.includes(event.name)) {
      return false;
    }

    if (filter.namespaces && !filter.namespaces.includes(event.origin.namespace)) {
      return false;
    }

    if (filter.families) {
      const family = getCanonicalEventFamily(event.name);
      if (!family || !filter.families.includes(family)) {
        return false;
      }
    }

    if (filter.pluginId && event.origin.pluginId !== filter.pluginId) {
      return false;
    }

    return filter.predicate ? filter.predicate(event) : true;
  }

  async function notify(event: CanonicalEvent): Promise<void> {
    for (const [subscriptionId, entry] of listeners) {
      if (!matchesFilter(event, entry.filter)) {
        continue;
      }

      try {
        await entry.listener(event);
      } catch (error) {
        options.onSubscriberError?.(error, event, subscriptionId);
      }
    }
  }

  function store(event: CanonicalEvent): void {
    history.push(event);

    if (
      options.historyLimit !== undefined &&
      options.historyLimit >= 0 &&
      history.length > options.historyLimit
    ) {
      history.splice(0, history.length - options.historyLimit);
    }
  }

  return {
    get closed() {
      return closed;
    },

    async emit<
      TName extends CanonicalEventName,
      TData extends CanonicalEventData = CanonicalEventData,
    >(event: CanonicalEventInput<TName, TData>): Promise<CanonicalEvent<TName, TData>> {
      if (closed) {
        throw new Error("Cannot emit to a closed canonical event stream.");
      }

      const sequence =
        event.sequence !== undefined && event.sequence > 0
          ? Math.max(event.sequence, nextSequence)
          : nextSequence;
      const sealedEvent = createCanonicalEvent(event, {
        ...options,
        sequence,
      });
      nextSequence = sealedEvent.sequence + 1;
      store(sealedEvent);
      await notify(sealedEvent);
      return sealedEvent;
    },

    async subscribe<TEvent extends CanonicalEvent = CanonicalEvent>(
      listener: CanonicalEventListener<TEvent>,
      filter?: CanonicalEventSubscriptionFilter,
    ): Promise<CanonicalEventSubscription> {
      if (closed) {
        throw new Error("Cannot subscribe to a closed canonical event stream.");
      }

      const id = `subscription-${nextSubscriptionId++}`;

      // Replay history before adding to live listeners to ensure correct ordering
      for (const event of history) {
        if (!matchesFilter(event, filter)) {
          continue;
        }

        try {
          await listener(event as TEvent);
        } catch (error) {
          options.onSubscriberError?.(error, event, id);
        }
      }

      // Only add to live listeners after history replay completes
      listeners.set(
        id,
        filter === undefined
          ? { listener: listener as CanonicalEventListener }
          : { listener: listener as CanonicalEventListener, filter },
      );

      return {
        id,
        get closed() {
          return !listeners.has(id);
        },
        close() {
          listeners.delete(id);
        },
      };
    },

    snapshot(
      filter?: Pick<CanonicalEventSubscriptionFilter, "fromSequence">,
    ): readonly CanonicalEvent[] {
      const fromSequence = filter?.fromSequence;
      if (fromSequence === undefined) {
        return [...history];
      }

      return history.filter((event) => event.sequence >= fromSequence);
    },

    close() {
      closed = true;
      listeners.clear();
    },
  };
}

export { createCanonicalEvent, getCanonicalEventFamily } from "./taxonomy.js";
export type {
  CanonicalCoreEventName,
  CanonicalEvent,
  CanonicalEventData,
  CanonicalEventFamily,
  CanonicalEventInput,
  CanonicalEventName,
} from "./taxonomy.js";
