import type { RunStoreContract } from "../contracts/run-store.js";
import type { CanonicalEventStream, CanonicalEventSubscription } from "../events/stream.js";
import type { CanonicalEvent } from "../events/taxonomy.js";

export interface AttachRunEventLogOptions {
  /** Only persist events for this run. Defaults to every event on the stream. */
  readonly runId?: string;
  readonly onError?: (error: unknown, event: CanonicalEvent) => void;
}

/**
 * Persists every event emitted on a canonical event stream to a run store.
 * Events are appended in emission order; the stream awaits each append before
 * notifying later subscribers of the next event.
 */
export async function attachRunEventLog(
  stream: CanonicalEventStream,
  store: Pick<RunStoreContract, "appendEvents">,
  options: AttachRunEventLogOptions = {},
): Promise<CanonicalEventSubscription> {
  return stream.subscribe(async (event) => {
    if (options.runId !== undefined && event.runId !== options.runId) {
      return;
    }
    try {
      await store.appendEvents(event.runId, [event]);
    } catch (error) {
      if (options.onError) {
        options.onError(error, event);
        return;
      }
      throw error;
    }
  });
}

export interface ReplayRunEventsOptions {
  readonly fromSequence?: number;
  /** Page size used when reading from the store. Defaults to 500. */
  readonly batchSize?: number;
}

/**
 * Reads a run's stored event log in sequence order, page by page, and hands
 * each event to `onEvent`. Returns the number of events replayed.
 */
export async function replayRunEvents(
  store: Pick<RunStoreContract, "readEvents">,
  runId: string,
  onEvent: (event: CanonicalEvent) => void | Promise<void>,
  options: ReplayRunEventsOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError("replayRunEvents batchSize must be a positive integer.");
  }
  let fromSequence = options.fromSequence ?? 0;
  let replayed = 0;
  for (;;) {
    const page = await store.readEvents(runId, { fromSequence, limit: batchSize });
    for (const event of page) {
      await onEvent(event);
      replayed += 1;
      fromSequence = event.sequence + 1;
    }
    if (page.length < batchSize) {
      return replayed;
    }
  }
}
