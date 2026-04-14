import type { RunScheduler, ScheduledTaskHandle } from "./types.js";

class ImmediateTaskHandle implements ScheduledTaskHandle {
  public cancelled = false;

  public cancel(): void {
    this.cancelled = true;
  }
}

export function createImmediateScheduler(): RunScheduler {
  return {
    schedule(task) {
      const handle = new ImmediateTaskHandle();
      if (!handle.cancelled) {
        void task();
      }

      return handle;
    },
  };
}
