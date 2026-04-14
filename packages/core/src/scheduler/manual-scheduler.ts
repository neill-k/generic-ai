import type { RunScheduler, ScheduledTaskHandle } from "./types.js";

interface ManualTaskEntry {
  readonly task: () => void | Promise<void>;
  readonly handle: ManualTaskHandle;
}

class ManualTaskHandle implements ScheduledTaskHandle {
  public cancelled = false;

  public cancel(): void {
    this.cancelled = true;
  }
}

export interface ManualRunScheduler extends RunScheduler {
  readonly pendingCount: number;
  flushNext(): Promise<boolean>;
  flushAll(): Promise<void>;
}

export function createManualScheduler(): ManualRunScheduler {
  const queue: ManualTaskEntry[] = [];

  const flushNext = async (): Promise<boolean> => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || next.handle.cancelled) {
        continue;
      }

      try {
        await next.task();
        return true;
      } catch (error) {
        throw error;
      }
    }

    return false;
  };

  return {
    get pendingCount() {
      return queue.filter((entry) => !entry.handle.cancelled).length;
    },
    schedule(task) {
      const handle = new ManualTaskHandle();
      queue.push({ task, handle });
      return handle;
    },
    flushNext,
    async flushAll() {
      while (await flushNext()) {
        // Drain the queue.
      }
    },
  };
}
