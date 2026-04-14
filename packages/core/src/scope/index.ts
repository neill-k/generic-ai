import { randomUUID } from "node:crypto";

export type ScopeId = string;

export type ScopeKind = string;

export type ScopeMetadata = Readonly<Record<string, unknown>>;

export interface ScopeLike {
  readonly id: ScopeId;
  readonly rootId?: ScopeId;
  readonly parentId?: ScopeId;
  readonly lineage?: ReadonlyArray<ScopeId>;
  readonly kind?: ScopeKind;
  readonly label?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface Scope extends ScopeLike {
  readonly rootId: ScopeId;
  readonly lineage: ReadonlyArray<ScopeId>;
  readonly metadata?: ScopeMetadata;
}

export interface ScopeInput {
  readonly id?: ScopeId;
  readonly kind?: ScopeKind;
  readonly label?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ScopeCreationOptions extends ScopeInput {
  readonly parent?: ScopeLike;
}

export interface ScopeCarrier {
  readonly scope: Scope;
}

const freezeMetadata = (
  metadata: Record<string, unknown> | undefined,
): ScopeMetadata | undefined => {
  if (metadata === undefined) {
    return undefined;
  }

  return Object.freeze({ ...metadata });
};

const freezeLineage = (lineage: ReadonlyArray<ScopeId>): ReadonlyArray<ScopeId> =>
  Object.freeze([...lineage]);

const resolveScopeId = (input: ScopeInput): ScopeId => input.id ?? randomUUID();

const normalizeParentLineage = (parent: ScopeLike): ReadonlyArray<ScopeId> => {
  if (parent.lineage !== undefined && parent.lineage.length > 0) {
    return parent.lineage;
  }

  return [parent.id];
};

const resolveRootId = (parent: ScopeLike): ScopeId =>
  parent.rootId ?? normalizeParentLineage(parent)[0] ?? parent.id;

type ScopeDraft = {
  readonly id: ScopeId;
  readonly rootId: ScopeId;
  readonly lineage: ReadonlyArray<ScopeId>;
  readonly parentId?: ScopeId;
  readonly kind?: ScopeKind;
  readonly label?: string;
  readonly metadata?: Record<string, unknown>;
};

const freezeScope = (scope: ScopeDraft): Scope => {
  const frozen: {
    id: ScopeId;
    rootId: ScopeId;
    lineage: ReadonlyArray<ScopeId>;
    parentId?: ScopeId;
    kind?: ScopeKind;
    label?: string;
    metadata?: ScopeMetadata;
  } = {
    id: scope.id,
    rootId: scope.rootId,
    lineage: freezeLineage(scope.lineage),
  };

  if (scope.parentId !== undefined) {
    frozen.parentId = scope.parentId;
  }

  if (scope.kind !== undefined) {
    frozen.kind = scope.kind;
  }

  if (scope.label !== undefined) {
    frozen.label = scope.label;
  }

  const metadata = freezeMetadata(scope.metadata);
  if (metadata !== undefined) {
    frozen.metadata = metadata;
  }

  return Object.freeze(frozen) as Scope;
};

const freezeCarrier = <T extends ScopeCarrier>(value: T): Readonly<T> => Object.freeze(value);

export function createRootScope(input: ScopeInput = {}): Scope {
  const id = resolveScopeId(input);

  return freezeScope({
    id,
    rootId: id,
    lineage: [id],
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });
}

export function createChildScope(parent: ScopeLike, input: ScopeInput = {}): Scope {
  const id = resolveScopeId(input);
  const lineage = [...normalizeParentLineage(parent), id];

  const kind = input.kind ?? parent.kind;

  return freezeScope({
    id,
    rootId: resolveRootId(parent),
    parentId: parent.id,
    lineage,
    ...(kind !== undefined ? { kind } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });
}

export function createScope(input: ScopeCreationOptions = {}): Scope {
  if (input.parent === undefined) {
    return createRootScope(input);
  }

  return createChildScope(input.parent, input);
}

export function isScope(value: unknown): value is Scope {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Scope>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.rootId === "string" &&
    Array.isArray(candidate.lineage) &&
    candidate.lineage.every((entry) => typeof entry === "string")
  );
}

export function isRootScope(scope: Scope): boolean {
  return scope.parentId === undefined;
}

export function scopeDepth(scope: Scope): number {
  return scope.lineage.length - 1;
}

export function scopeRootId(scope: Scope): ScopeId {
  return scope.rootId;
}

export function scopeLineage(scope: Scope): ReadonlyArray<ScopeId> {
  return scope.lineage;
}

export function scopeChain(scope: Scope): ReadonlyArray<ScopeId> {
  return scope.lineage;
}

export function hasScope(value: unknown): value is ScopeCarrier {
  return value !== null && typeof value === "object" && "scope" in value && isScope((value as ScopeCarrier).scope);
}

export function getScope(value: unknown): Scope | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  if (!("scope" in value)) {
    return undefined;
  }

  const candidate = (value as Partial<ScopeCarrier>).scope;

  return candidate !== undefined && isScope(candidate) ? candidate : undefined;
}

export function withScope<T extends object>(value: T, scope: Scope): Readonly<T & ScopeCarrier> {
  return freezeCarrier({
    ...(value as T),
    scope,
  });
}

export function withChildScope<T extends object>(
  value: T,
  parent: ScopeLike,
  input: ScopeInput = {},
): Readonly<T & ScopeCarrier> {
  return withScope(value, createChildScope(parent, input));
}

export function ensureScope<T extends object>(
  value: T,
  scope: Scope,
): Readonly<T & ScopeCarrier> {
  const currentScope = getScope(value);

  if (currentScope !== undefined) {
    return withScope(value, currentScope);
  }

  return withScope(value, scope);
}

export function inheritScope<T extends object>(
  value: T,
  parent: ScopeLike,
  input: ScopeInput = {},
): Readonly<T & ScopeCarrier> {
  const inheritedScope = createChildScope(parent, input);

  return withScope(value, inheritedScope);
}
