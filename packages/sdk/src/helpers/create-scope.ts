import type { JsonValue } from "../contracts/shared.js";
import type { Scope, ScopeKind } from "../contracts/scope.js";

export interface CreateScopeInput {
  readonly id: string;
  readonly scopeKind: ScopeKind;
  readonly parent?: Scope;
  readonly labels?: Readonly<Record<string, string>>;
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

export function createScope(input: CreateScopeInput): Scope {
  const parentId = input.parent?.id;
  const rootId = input.parent?.rootId ?? input.id;
  const lineage = input.parent ? [...input.parent.lineage, input.id] : [input.id];

  return {
    kind: "scope",
    id: input.id,
    scopeKind: input.scopeKind,
    rootId,
    lineage,
    labels: { ...(input.labels ?? {}) },
    attributes: { ...(input.attributes ?? {}) },
    ...(parentId === undefined ? {} : { parentId }),
  };
}

