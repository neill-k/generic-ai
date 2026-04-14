export type SessionId = string;

export type SessionKind = "root" | "child";

export type SessionStatus = "active" | "succeeded" | "failed" | "cancelled";

export interface SessionMetadata {
  readonly [key: string]: unknown;
}

export interface SessionErrorSnapshot {
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

export interface SessionStartOptions {
  readonly id?: SessionId;
  readonly metadata?: SessionMetadata;
}

export interface SessionCompleteOptions {
  readonly result?: unknown;
  readonly metadata?: SessionMetadata;
}

export interface SessionFailOptions {
  readonly error: Error | string;
  readonly metadata?: SessionMetadata;
}

export interface SessionCancelOptions {
  readonly reason?: string;
  readonly metadata?: SessionMetadata;
}

export interface SessionTerminalState {
  readonly id: SessionId;
  readonly kind: SessionKind;
  readonly status: Exclude<SessionStatus, "active">;
  readonly parentSessionId: SessionId | undefined;
  readonly rootSessionId: SessionId;
  readonly endedAt: number;
  readonly childSessionIds: readonly SessionId[];
  readonly result: unknown;
  readonly error: SessionErrorSnapshot | undefined;
  readonly cancellationReason: string | undefined;
  readonly metadata: SessionMetadata;
}

export interface SessionSnapshot {
  readonly id: SessionId;
  readonly kind: SessionKind;
  readonly status: SessionStatus;
  readonly parentSessionId: SessionId | undefined;
  readonly rootSessionId: SessionId;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly endedAt: number | undefined;
  readonly childSessionIds: readonly SessionId[];
  readonly childSessions: readonly SessionSnapshot[];
  readonly terminalState: SessionTerminalState | undefined;
  readonly terminalStates: readonly SessionTerminalState[];
  readonly result: unknown;
  readonly error: SessionErrorSnapshot | undefined;
  readonly cancellationReason: string | undefined;
  readonly metadata: SessionMetadata;
}
