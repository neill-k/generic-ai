import type { Awaitable, JsonValue } from "./shared.js";

export type MemoryRecordKind =
  | "entry"
  | "episode"
  | "fact"
  | "summary"
  | "procedure"
  | "entity"
  | "edge"
  | (string & {});

export type MemoryMetadata = Readonly<Record<string, JsonValue>>;

export interface MemoryProvenanceRef {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly offsets?: readonly [number, number];
  readonly metadata?: MemoryMetadata;
}

export interface MemoryRecordInput {
  readonly id?: string;
  readonly namespace?: string;
  readonly kind?: MemoryRecordKind;
  readonly text: string;
  readonly tags?: readonly string[];
  readonly metadata?: MemoryMetadata;
  readonly importance?: number;
  readonly salience?: number;
  readonly validFrom?: string;
  readonly validTo?: string | null;
  readonly provenance?: readonly MemoryProvenanceRef[];
  readonly supersedes?: readonly string[];
}

export interface MemoryRecord extends MemoryRecordInput {
  readonly id: string;
  readonly agentId: string;
  readonly tags: readonly string[];
  readonly metadata: MemoryMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryListFilter {
  readonly namespace?: string;
  readonly kind?: MemoryRecordKind;
  readonly tags?: readonly string[];
  readonly metadata?: MemoryMetadata;
}

export interface MemorySearchQuery extends MemoryListFilter {
  readonly text: string;
  readonly limit?: number;
  readonly asOf?: string;
  readonly includeExpired?: boolean;
}

export interface MemorySearchResult<TRecord extends MemoryRecord = MemoryRecord> {
  readonly entry: TRecord;
  readonly score: number;
  readonly matches?: readonly string[];
  readonly reasons?: readonly string[];
}

export interface MemoryConsolidationPlan {
  readonly strategy?: "summary" | "profile" | "procedure" | (string & {});
  readonly sourceIds?: readonly string[];
  readonly metadata?: MemoryMetadata;
}

export interface MemoryConsolidationResult<TRecord extends MemoryRecord = MemoryRecord> {
  readonly created: readonly TRecord[];
  readonly updated: readonly TRecord[];
  readonly sourceIds: readonly string[];
}

export interface MemoryProvenanceReport {
  readonly recordId: string;
  readonly sources: readonly MemoryProvenanceRef[];
  readonly supersedes?: readonly string[];
}

export interface MemoryTimelineQuery extends MemorySearchQuery {
  readonly before?: string;
  readonly after?: string;
  readonly during?: {
    readonly start: string;
    readonly end: string;
  };
  readonly currentOnly?: boolean;
}

export interface MemoryTimelineResult<TRecord extends MemoryRecord = MemoryRecord> {
  readonly entry: TRecord;
  readonly relationship: "before" | "during" | "after" | "current" | (string & {});
}

export interface MemoryGraphQuery {
  readonly text?: string;
  readonly seedIds?: readonly string[];
  readonly depth?: number;
  readonly limit?: number;
}

export interface MemoryGraphResult<TRecord extends MemoryRecord = MemoryRecord> {
  readonly nodes: readonly TRecord[];
  readonly edges: readonly TRecord[];
}

export interface MemoryService<
  TRecord extends MemoryRecord = MemoryRecord,
  TInput extends MemoryRecordInput = MemoryRecordInput,
  TResult extends MemorySearchResult<TRecord> = MemorySearchResult<TRecord>,
> {
  readonly capability: "memory";
  readonly driver: string;
  remember(agentId: string, entry: TInput): Awaitable<TRecord>;
  get(agentId: string, id: string): Awaitable<TRecord | undefined>;
  list(agentId: string, filter?: MemoryListFilter): Awaitable<readonly TRecord[]>;
  search(agentId: string, query: string | MemorySearchQuery, limit?: number): Awaitable<readonly TResult[]>;
  forget(agentId: string, id: string): Awaitable<boolean>;
  consolidate?(
    agentId: string,
    plan?: MemoryConsolidationPlan,
  ): Awaitable<MemoryConsolidationResult<TRecord>>;
  explain?(agentId: string, recordId: string): Awaitable<MemoryProvenanceReport>;
  timeline?(
    agentId: string,
    query: MemoryTimelineQuery,
  ): Awaitable<readonly MemoryTimelineResult<TRecord>[]>;
  graph?(agentId: string, query: MemoryGraphQuery): Awaitable<MemoryGraphResult<TRecord>>;
}
