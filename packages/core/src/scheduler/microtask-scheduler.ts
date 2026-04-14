import type { RunScheduler, ScheduledTaskHandle } from "./types.js";

class MicrotaskHandle implements ScheduledTaskHandle {
  public cancelled = false;

  public cancel(): void {
    this.cancelled = true;
  }
}

export function createMicrotaskScheduler(): RunScheduler {
  return {
    schedule(task) {
      const handle = new MicrotaskHandle();

      queueMicrotask(() => {
        if (!handle.cancelled) {
          void task();
        }
      });

      return handle;
    },
  };
}

