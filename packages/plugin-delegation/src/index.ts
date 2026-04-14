import { SessionOrchestrator, type SessionSnapshot } from "@generic-ai/core";

export const name = "@generic-ai/plugin-delegation" as const;
export const kind = "delegation" as const;

export interface DelegationRequest<TTask = unknown> {
  readonly agentId: string;
  readonly task: TTask;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DelegationResult<TResult = unknown> {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly agentId: string;
  readonly status: SessionSnapshot["status"];
  readonly task: unknown;
  readonly result: TResult | undefined;
  readonly error: SessionSnapshot["error"];
  readonly cancellationReason: string | undefined;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DelegationExecutorContext {
  readonly orchestrator: SessionOrchestrator;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly rootSessionId: string;
}

export type DelegationExecutor<TTask, TResult> = (
  request: DelegationRequest<TTask>,
  context: DelegationExecutorContext,
) => Promise<TResult> | TResult;

export interface DelegationCoordinatorOptions {
  readonly orchestrator?: SessionOrchestrator;
}

export interface DelegationCoordinator {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly orchestrator: SessionOrchestrator;
  createRootSession(
    metadata?: Readonly<Record<string, unknown>>,
  ): SessionSnapshot;
  delegate<TTask, TResult>(
    parentSessionId: string,
    request: DelegationRequest<TTask>,
    executor: DelegationExecutor<TTask, TResult>,
  ): Promise<DelegationResult<TResult>>;
  delegateMany<TTask, TResult>(
    parentSessionId: string,
    requests: readonly DelegationRequest<TTask>[],
    executor: DelegationExecutor<TTask, TResult>,
  ): Promise<readonly DelegationResult<TResult>[]>;
  list(rootSessionId?: string): readonly DelegationResult[];
}

function isAbortError(value: unknown): value is Error {
  return value instanceof Error && value.name === "AbortError";
}

function isTerminalSnapshot(snapshot: SessionSnapshot | undefined): snapshot is SessionSnapshot {
  return snapshot !== undefined && snapshot.status !== "active";
}

/**
 * Complete a child session, tolerating the case where another actor already
 * terminalized it (for example a cascading cancellation from the parent).
 */
function terminalizeSuccess(
  orchestrator: SessionOrchestrator,
  childSessionId: string,
  result: unknown,
): SessionSnapshot {
  const existing = orchestrator.getSession(childSessionId);
  if (isTerminalSnapshot(existing)) {
    return existing;
  }

  return orchestrator.completeSession(childSessionId, { result });
}

/**
 * Record a failure or cancellation for a child session, tolerating the case
 * where another actor already terminalized it. Falling back to the existing
 * terminal snapshot prevents `delegate()` from rejecting with
 * "Session ... is already terminal" when cancellation cascades from a parent.
 */
function terminalizeFailure(
  orchestrator: SessionOrchestrator,
  childSessionId: string,
  error: unknown,
): SessionSnapshot {
  const existing = orchestrator.getSession(childSessionId);
  if (isTerminalSnapshot(existing)) {
    return existing;
  }

  if (isAbortError(error)) {
    return orchestrator.cancelSession(
      childSessionId,
      error.message.length === 0 ? {} : { reason: error.message },
    );
  }

  return orchestrator.failSession(childSessionId, {
    error: error instanceof Error ? error : String(error),
  });
}

function toDelegationResult(
  snapshot: SessionSnapshot,
  request: DelegationRequest,
): DelegationResult {
  return Object.freeze({
    sessionId: snapshot.id,
    parentSessionId: snapshot.parentSessionId ?? snapshot.id,
    rootSessionId: snapshot.rootSessionId,
    agentId: request.agentId,
    status: snapshot.status,
    task: request.task,
    result: snapshot.result,
    error: snapshot.error,
    cancellationReason: snapshot.cancellationReason,
    startedAt: snapshot.createdAt,
    endedAt: snapshot.endedAt,
    metadata: {
      ...(request.metadata ?? {}),
    },
  });
}

export function createDelegationCoordinator(
  options: DelegationCoordinatorOptions = {},
): DelegationCoordinator {
  const orchestrator = options.orchestrator ?? new SessionOrchestrator();
  const records = new Map<string, DelegationResult>();

  const coordinator: DelegationCoordinator = {
    name,
    kind,
    orchestrator,
    createRootSession(metadata?: Readonly<Record<string, unknown>>): SessionSnapshot {
      return orchestrator.createRootSession(metadata === undefined ? {} : { metadata });
    },
    async delegate<TTask, TResult>(
      parentSessionId: string,
      request: DelegationRequest<TTask>,
      executor: DelegationExecutor<TTask, TResult>,
    ): Promise<DelegationResult<TResult>> {
      const child = orchestrator.createChildSession(parentSessionId, {
        metadata: {
          agentId: request.agentId,
          task: request.task,
          ...(request.metadata ?? {}),
        },
      });

      const context: DelegationExecutorContext = Object.freeze({
        orchestrator,
        parentSessionId,
        childSessionId: child.id,
        rootSessionId: child.rootSessionId,
      });

      let terminal: SessionSnapshot;

      try {
        const result = await executor(request, context);
        terminal = terminalizeSuccess(orchestrator, child.id, result);
      } catch (error) {
        terminal = terminalizeFailure(orchestrator, child.id, error);
      }

      const record = toDelegationResult(terminal, request) as DelegationResult<TResult>;
      records.set(record.sessionId, record);
      return record;
    },
    async delegateMany<TTask, TResult>(
      parentSessionId: string,
      requests: readonly DelegationRequest<TTask>[],
      executor: DelegationExecutor<TTask, TResult>,
    ): Promise<readonly DelegationResult<TResult>[]> {
      return Promise.all(requests.map((request) => coordinator.delegate(parentSessionId, request, executor)));
    },
    list(rootSessionId?: string): readonly DelegationResult[] {
      return [...records.values()].filter((record) =>
        rootSessionId === undefined ? true : record.rootSessionId === rootSessionId,
      );
    },
  };

  return coordinator;
}
