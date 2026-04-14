import type { Awaitable } from "./shared.js";

export type LifecyclePhase =
  | "constructed"
  | "registered"
  | "configuring"
  | "configured"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface LifecycleEvent {
  readonly phase: LifecyclePhase;
  readonly at: string;
  readonly subjectId: string;
  readonly reason?: string;
}

export interface LifecycleHooks<TContext = unknown> {
  readonly configure?: (context: TContext) => Awaitable<void>;
  readonly start?: (context: TContext) => Awaitable<void>;
  readonly stop?: (context: TContext) => Awaitable<void>;
}
