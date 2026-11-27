import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/**
 * One live connection to `/api/events` for the whole app. Screens subscribe to the event types
 * they care about and refetch; the server stays the only source of truth.
 */
export interface LiveEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

type Listener = (event: LiveEvent) => void;
type StatusListener = (connected: boolean) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
let source: EventSource | undefined;
let connected = false;

function setConnected(value: boolean) {
  connected = value;
  for (const listener of statusListeners) {
    listener(value);
  }
}

function connect() {
  if (source !== undefined) {
    return;
  }
  source = new EventSource("/api/events?unnamed=1");
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.onmessage = (message) => dispatch(message);
}

function dispatch(message: MessageEvent<string>) {
  let parsed: { type?: string; data?: Record<string, unknown> } = {};
  try {
    parsed = JSON.parse(message.data) as typeof parsed;
  } catch {
    return;
  }
  const event: LiveEvent = {
    id: Number(message.lastEventId) || 0,
    type: parsed.type ?? message.type,
    data: parsed.data ?? {},
  };
  for (const listener of listeners) {
    listener(event);
  }
}

export function onLive(listener: Listener): () => void {
  connect();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveStatus(): boolean {
  const [value, setValue] = useState(connected);
  useEffect(() => {
    connect();
    statusListeners.add(setValue);
    return () => statusListeners.delete(setValue);
  }, []);
  return value;
}

export interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data and loads it again, at most every 600 ms, whenever a live event matches `refreshOn`.
 */
export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  refreshOn: (event: LiveEvent) => boolean = () => false,
): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const refreshRef = useRef(refreshOn);
  refreshRef.current = refreshOn;

  const reload = useCallback(() => {
    const mine = ++generation.current;
    loadRef
      .current()
      .then((value) => {
        if (mine === generation.current) {
          setData(value);
          setError(undefined);
        }
      })
      .catch((reason: unknown) => {
        if (mine === generation.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (mine === generation.current) {
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    setLoading(true);
    setData(undefined);
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onLive((event) => {
      if (!refreshRef.current(event) || timer !== undefined) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        reload();
      }, 600);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, deps);

  return { data, error, loading, reload };
}

export const isWorkEvent = (event: LiveEvent): boolean =>
  event.type.startsWith("task.") ||
  event.type.startsWith("thread.") ||
  event.type.startsWith("drive.");
