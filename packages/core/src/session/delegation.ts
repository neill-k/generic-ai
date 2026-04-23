import type {
  DelegationExecutor,
  DelegationExecutorContext,
  DelegationRequest,
  DelegationResult,
} from "@generic-ai/sdk";

import { SessionOrchestrator } from "./orchestrator.js";
import type { SessionMetadata, SessionSnapshot } from "./types.js";

type TerminalSessionSnapshot = SessionSnapshot & {
  readonly status: Exclude<SessionSnapshot["status"], "active">;
};

export interface DelegationCoordinatorOptions {
  readonly orchestrator?: SessionOrchestrator;
}

export interface DelegationCoordinator {
  readonly kind: "delegation";
  readonly orchestrator: SessionOrchestrator;
  createRootSession(metadata?: SessionMetadata): SessionSnapshot;
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

function isTerminalSnapshot(
  snapshot: SessionSnapshot | undefined,
): snapshot is TerminalSessionSnapshot {
  return snapshot !== undefined && snapshot.status !== "active";
}

function terminalizeSuccess(
  orchestrator: SessionOrchestrator,
  childSessionId: string,
  result: unknown,
): TerminalSessionSnapshot {
  const existing = orchestrator.getSession(childSessionId);
  if (isTerminalSnapshot(existing)) {
    return existing;
  }

  return orchestrator.completeSession(childSessionId, { result }) as TerminalSessionSnapshot;
}

function terminalizeFailure(
  orchestrator: SessionOrchestrator,
  childSessionId: string,
  error: unknown,
): TerminalSessionSnapshot {
  const existing = orchestrator.getSession(childSessionId);
  if (isTerminalSnapshot(existing)) {
    return existing;
  }

  if (isAbortError(error)) {
    return orchestrator.cancelSession(
      childSessionId,
      error.message.length === 0 ? {} : { reason: error.message },
    ) as TerminalSessionSnapshot;
  }

  return orchestrator.failSession(childSessionId, {
    error: error instanceof Error ? error : String(error),
  }) as TerminalSessionSnapshot;
}

function toDelegationResult(
  snapshot: TerminalSessionSnapshot,
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
    kind: "delegation",
    orchestrator,
    createRootSession(metadata?: SessionMetadata): SessionSnapshot {
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
        parentSessionId,
        childSessionId: child.id,
        rootSessionId: child.rootSessionId,
      });

      let terminal: TerminalSessionSnapshot;

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
