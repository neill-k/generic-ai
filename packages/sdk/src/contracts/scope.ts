import type { JsonValue } from "./shared.js";

export type ScopeKind =
  | "framework"
  | "preset"
  | "plugin"
  | "workspace"
  | "run"
  | "session"
  | "agent"
  | "task"
  | "custom";

export interface Scope {
  readonly kind: "scope";
  readonly id: string;
  readonly scopeKind: ScopeKind;
  readonly rootId: string;
  readonly parentId?: string;
  readonly lineage: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

