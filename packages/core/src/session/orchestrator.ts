import { randomUUID } from "node:crypto";

import type {
  SessionCancelOptions,
  SessionCompleteOptions,
  SessionErrorSnapshot,
  SessionFailOptions,
  SessionId,
  SessionKind,
  SessionMetadata,
  SessionSnapshot,
  SessionStartOptions,
  SessionStatus,
  SessionTerminalState,
} from "./types.js";

interface SessionRecord {
  readonly id: SessionId;
  readonly kind: SessionKind;
  readonly parentSessionId: SessionId | undefined;
  readonly rootSessionId: SessionId;
  readonly createdAt: number;
  updatedAt: number;
  endedAt: number | undefined;
  status: SessionStatus;
  metadata: SessionMetadata;
  result: unknown;
  error: SessionErrorSnapshot | undefined;
  cancellationReason: string | undefined;
  childSessionIds: SessionId[];
}

interface SessionOrchestratorOptions {
  readonly now?: () => number;
  readonly idFactory?: () => SessionId;
}

export class SessionOrchestrator {
  private readonly sessions = new Map<SessionId, SessionRecord>();

  private readonly now: () => number;

  private readonly idFactory: () => SessionId;

  constructor(options: SessionOrchestratorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  createRootSession(options: SessionStartOptions = {}): SessionSnapshot {
    const id = this.requireUniqueId(options.id ?? this.idFactory());
    const timestamp = this.now();

    this.sessions.set(id, {
      id,
      kind: "root",
      parentSessionId: undefined,
      rootSessionId: id,
      createdAt: timestamp,
      updatedAt: timestamp,
      endedAt: undefined,
      status: "active",
      metadata: { ...(options.metadata ?? {}) },
      result: undefined,
      error: undefined,
      cancellationReason: undefined,
      childSessionIds: [],
    });

    return this.getRequiredSession(id);
  }

  createChildSession(
    parentSessionId: SessionId,
    options: SessionStartOptions = {},
  ): SessionSnapshot {
    const parent = this.getRequiredRecord(parentSessionId);

    if (parent.status !== "active") {
      throw new Error(`Cannot create a child session under terminal session ${parentSessionId}.`);
    }

    const id = this.requireUniqueId(options.id ?? this.idFactory());
    const timestamp = this.now();

    this.sessions.set(id, {
      id,
      kind: "child",
      parentSessionId: parent.id,
      rootSessionId: parent.rootSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      endedAt: undefined,
      status: "active",
      metadata: { ...(options.metadata ?? {}) },
      result: undefined,
      error: undefined,
      cancellationReason: undefined,
      childSessionIds: [],
    });

    parent.childSessionIds = [...parent.childSessionIds, id];
    parent.updatedAt = timestamp;

    return this.getRequiredSession(id);
  }

  completeSession(sessionId: SessionId, options: SessionCompleteOptions = {}): SessionSnapshot {
    const record = this.getRequiredRecord(sessionId);
    this.ensureActive(record);
    this.ensureNoActiveDescendantsForSuccess(record);

    const timestamp = this.now();

    record.status = "succeeded";
    record.updatedAt = timestamp;
    record.endedAt = timestamp;
    record.result = options.result;
    record.metadata = { ...record.metadata, ...(options.metadata ?? {}) };

    return this.getRequiredSession(sessionId);
  }

  failSession(sessionId: SessionId, options: SessionFailOptions): SessionSnapshot {
    const record = this.getRequiredRecord(sessionId);
    this.ensureActive(record);

    const timestamp = this.now();
    record.status = "failed";
    record.updatedAt = timestamp;
    record.endedAt = timestamp;
    record.error = this.normalizeError(options.error);
    record.cancellationReason = undefined;
    record.metadata = { ...record.metadata, ...(options.metadata ?? {}) };

    this.cancelActiveDescendants(record, this.buildCascadeReason(record, "failed"));

    return this.getRequiredSession(sessionId);
  }

  cancelSession(sessionId: SessionId, options: SessionCancelOptions = {}): SessionSnapshot {
    const record = this.getRequiredRecord(sessionId);
    this.ensureActive(record);

    const timestamp = this.now();
    record.status = "cancelled";
    record.updatedAt = timestamp;
    record.endedAt = timestamp;
    record.cancellationReason = options.reason;
    record.error = undefined;
    record.metadata = { ...record.metadata, ...(options.metadata ?? {}) };

    this.cancelActiveDescendants(
      record,
      options.reason ?? this.buildCascadeReason(record, "cancelled"),
    );

    return this.getRequiredSession(sessionId);
  }

  getSession(sessionId: SessionId): SessionSnapshot | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return undefined;
    }

    return this.toSnapshot(record);
  }

  collectTerminalStates(sessionId: SessionId): readonly SessionTerminalState[] {
    const record = this.getRequiredRecord(sessionId);
    return this.collectTerminalStatesFromRecord(record);
  }

  private cancelActiveDescendants(record: SessionRecord, reason: string): void {
    for (const childSessionId of record.childSessionIds) {
      const child = this.getRequiredRecord(childSessionId);
      if (child.status === "active") {
        this.terminalizeCancelled(child, reason);
      }
    }
  }

  private terminalizeCancelled(record: SessionRecord, reason: string): void {
    const timestamp = this.now();
    record.status = "cancelled";
    record.updatedAt = timestamp;
    record.endedAt = timestamp;
    record.cancellationReason = reason;
    record.error = undefined;
    record.metadata = { ...record.metadata };

    this.cancelActiveDescendants(record, reason);
  }

  private ensureActive(record: SessionRecord): void {
    if (record.status !== "active") {
      throw new Error(`Session ${record.id} is already terminal.`);
    }
  }

  private ensureNoActiveDescendantsForSuccess(record: SessionRecord): void {
    const activeDescendant = this.findFirstActiveDescendant(record);
    if (activeDescendant) {
      throw new Error(
        `Cannot complete session ${record.id} while descendant session ${activeDescendant.id} is still active.`,
      );
    }
  }

  private findFirstActiveDescendant(record: SessionRecord): SessionRecord | undefined {
    for (const childSessionId of record.childSessionIds) {
      const child = this.getRequiredRecord(childSessionId);
      if (child.status === "active") {
        return child;
      }

      const nestedActive = this.findFirstActiveDescendant(child);
      if (nestedActive) {
        return nestedActive;
      }
    }

    return undefined;
  }

  private collectTerminalStatesFromRecord(record: SessionRecord): readonly SessionTerminalState[] {
    const states: SessionTerminalState[] = [];

    for (const childSessionId of record.childSessionIds) {
      const child = this.getRequiredRecord(childSessionId);
      states.push(...this.collectTerminalStatesFromRecord(child));
    }

    if (record.status !== "active") {
      states.push(this.toTerminalState(record));
    }

    return states;
  }

  private toSnapshot(record: SessionRecord): SessionSnapshot {
    const terminalState = record.status === "active" ? undefined : this.toTerminalState(record);

    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      parentSessionId: record.parentSessionId,
      rootSessionId: record.rootSessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      endedAt: record.endedAt,
      childSessionIds: [...record.childSessionIds],
      childSessions: record.childSessionIds.map((childSessionId) =>
        this.getRequiredSession(childSessionId),
      ),
      terminalState,
      terminalStates: this.collectTerminalStatesFromRecord(record),
      result: record.result,
      error: record.error,
      cancellationReason: record.cancellationReason,
      metadata: { ...record.metadata },
    };
  }

  private toTerminalState(record: SessionRecord): SessionTerminalState {
    if (record.status === "active") {
      throw new Error(`Session ${record.id} is not terminal.`);
    }

    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      parentSessionId: record.parentSessionId,
      rootSessionId: record.rootSessionId,
      endedAt: record.endedAt ?? this.now(),
      childSessionIds: [...record.childSessionIds],
      result: record.result,
      error: record.error,
      cancellationReason: record.cancellationReason,
      metadata: { ...record.metadata },
    };
  }

  private normalizeError(error: Error | string): SessionErrorSnapshot {
    if (typeof error === "string") {
      return {
        name: "Error",
        message: error,
        stack: undefined,
      };
    }

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  private buildCascadeReason(record: SessionRecord, status: "failed" | "cancelled"): string {
    if (status === "failed") {
      return `Parent session ${record.id} failed.`;
    }

    return `Parent session ${record.id} was cancelled.`;
  }

  private getRequiredSession(sessionId: SessionId): SessionSnapshot {
    const record = this.getRequiredRecord(sessionId);
    return this.toSnapshot(record);
  }

  private getRequiredRecord(sessionId: SessionId): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session ${sessionId}.`);
    }

    return record;
  }

  private requireUniqueId(sessionId: SessionId): SessionId {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists.`);
    }

    return sessionId;
  }
}
