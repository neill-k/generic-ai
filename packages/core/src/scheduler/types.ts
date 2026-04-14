export interface ScheduledTaskHandle {
  readonly cancelled: boolean;
  cancel(): void;
}

export interface RunScheduler {
  schedule(task: () => void | Promise<void>): ScheduledTaskHandle;
}

