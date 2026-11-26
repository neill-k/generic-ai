import { randomUUID } from "node:crypto";

import {
  ApprovalError,
  type ApprovalLifecycleEventType,
  type ApprovalListFilter,
  type ApprovalRequest,
  type ApprovalServiceContract,
  type ApprovalServiceEvent,
  type ApprovalStatus,
  approvalInputDigest,
  type Awaitable,
  type CanonicalEvent,
  type CompleteApprovalExecutionInput,
  DEFAULT_APPROVAL_TTL_MS,
  isRunStoreError,
  type JsonValue,
  type RunActor,
  type RunEnvelope,
  type RunRecord,
  type RunStoreContract,
} from "@generic-ai/sdk";

/**
 * Approval requests stored in the SDK run store.
 *
 * Each request is a run record (`kind: approval-request` in its metadata) under
 * the `approvals` root scope, so it works on SQLite and Postgres, gets
 * optimistic versioning for safe decisions and execution claims, and keeps its
 * own append-only event log as the audit trail.
 */
export const APPROVALS_PLUGIN_ID = "@generic-ai/plugin-approvals";
export const APPROVAL_RUN_KIND = "approval-request";
export const APPROVALS_SCOPE_ID = "approvals";

export interface CreateApprovalServiceOptions {
  readonly runStore: RunStoreContract;
  /** Lifetime of a request when neither the caller nor the policy sets one. Defaults to 72 hours. */
  readonly defaultTtlMs?: number;
  /** Largest action input stored with a request, in bytes of JSON. Defaults to 64 KiB. */
  readonly maxInputBytes?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Errors thrown by subscribers or event logging. They never break a decision. */
  readonly onError?: (error: unknown) => void;
}

const POLICY_ACTOR: RunActor = Object.freeze({
  subjectId: "policy",
  actorType: "service",
  credentialSource: "custom",
  displayName: "Approval policy",
});

type StoredApproval = Omit<ApprovalRequest, "version">;

function envelopeStatus(approval: StoredApproval): RunEnvelope["status"] {
  switch (approval.status) {
    case "pending":
      return "created";
    case "approved":
      if (approval.execution === undefined || approval.execution.state === "started") {
        return "running";
      }
      return approval.execution.state === "succeeded" ? "succeeded" : "failed";
    case "rejected":
    case "denied":
      return "failed";
    default:
      return "cancelled";
  }
}

/** Run-envelope statuses a request with this approval status can be stored under. */
function envelopeStatusesFor(status: ApprovalStatus): readonly RunEnvelope["status"][] {
  switch (status) {
    case "pending":
      return ["created"];
    case "approved":
      return ["running", "succeeded", "failed"];
    case "rejected":
    case "denied":
      return ["failed"];
    default:
      return ["cancelled"];
  }
}

function toRun(approval: StoredApproval): {
  readonly envelope: RunEnvelope;
  readonly metadata: Record<string, JsonValue>;
} {
  const closed = approval.status !== "pending";
  return {
    envelope: {
      kind: "run-envelope",
      runId: approval.approvalId,
      rootScopeId: APPROVALS_SCOPE_ID,
      rootAgentId: approval.requester.agentId,
      mode: "async",
      status: envelopeStatus(approval),
      timestamps: {
        createdAt: approval.createdAt,
        ...(closed ? { completedAt: approval.updatedAt } : {}),
        ...(approval.status === "cancelled" || approval.status === "expired"
          ? { cancelledAt: approval.updatedAt }
          : {}),
      },
      eventStream: { kind: "event-stream-reference", streamId: approval.approvalId },
      ...(approval.requester.actor === undefined ? {} : { actor: approval.requester.actor }),
    },
    metadata: {
      kind: APPROVAL_RUN_KIND,
      approval: JSON.parse(JSON.stringify(approval)) as JsonValue,
    },
  };
}

export function runToApproval(record: RunRecord): ApprovalRequest | undefined {
  if (record.metadata?.["kind"] !== APPROVAL_RUN_KIND) {
    return undefined;
  }
  const stored = record.metadata["approval"];
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return undefined;
  }
  return { ...(stored as unknown as StoredApproval), version: record.version };
}

function matchesFilter(approval: ApprovalRequest, filter: ApprovalListFilter): boolean {
  const statuses =
    filter.status === undefined
      ? undefined
      : typeof filter.status === "string"
        ? [filter.status]
        : filter.status;
  return (
    (statuses === undefined || statuses.includes(approval.status)) &&
    (filter.taskId === undefined || approval.requester.taskId === filter.taskId) &&
    (filter.rootTaskId === undefined || approval.requester.rootTaskId === filter.rootTaskId) &&
    (filter.agentId === undefined || approval.requester.agentId === filter.agentId) &&
    (filter.runId === undefined || approval.requester.runId === filter.runId)
  );
}

export function createApprovalService(
  options: CreateApprovalServiceOptions,
): ApprovalServiceContract {
  const store = options.runStore;
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => `apr-${randomUUID()}`);
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const maxInputBytes = options.maxInputBytes ?? 64 * 1024;
  const listeners = new Set<(event: ApprovalServiceEvent) => Awaitable<void>>();

  const reportError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Error reporting must not throw.
    }
  };

  async function load(approvalId: string): Promise<ApprovalRequest | undefined> {
    const record = await store.getRun(approvalId);
    return record === undefined ? undefined : runToApproval(record);
  }

  /** Read-modify-write with optimistic concurrency. `mutate` returns undefined to skip. */
  async function update(
    approvalId: string,
    mutate: (current: ApprovalRequest) => Partial<StoredApproval> | undefined,
  ): Promise<{ readonly approval: ApprovalRequest; readonly changed: boolean }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await load(approvalId);
      if (current === undefined) {
        throw new ApprovalError("NOT_FOUND", `Unknown approval request "${approvalId}".`);
      }
      const patch = mutate(current);
      if (patch === undefined) {
        return { approval: current, changed: false };
      }
      const { version, ...rest } = current;
      const next: StoredApproval = { ...rest, ...patch, updatedAt: now().toISOString() };
      const { envelope, metadata } = toRun(next);
      try {
        const saved = await store.saveRun({ envelope, metadata, expectedVersion: version });
        return { approval: { ...next, version: saved.version }, changed: true };
      } catch (error) {
        if (!isRunStoreError(error, "VERSION_CONFLICT")) {
          throw error;
        }
      }
    }
    throw new Error(`Approval ${approvalId} kept changing under concurrent updates.`);
  }

  async function record(
    type: ApprovalLifecycleEventType,
    approval: ApprovalRequest,
    data: Record<string, unknown> = {},
    actor?: RunActor,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const sequence = (await store.lastSequence(approval.approvalId)) + 1;
        const event: CanonicalEvent = {
          eventId: `${approval.approvalId}:${sequence}:${randomUUID()}`,
          sequence,
          occurredAt: now().toISOString(),
          name: type,
          origin: { namespace: "plugin", pluginId: APPROVALS_PLUGIN_ID, subsystem: "approvals" },
          scopeId: APPROVALS_SCOPE_ID,
          runId: approval.approvalId,
          rootSessionId: `${approval.approvalId}:approval`,
          sessionId: `${approval.approvalId}:approval`,
          ...(actor === undefined ? {} : { actor }),
          data: {
            approvalId: approval.approvalId,
            status: approval.status,
            agentId: approval.requester.agentId,
            ...(approval.requester.taskId === undefined
              ? {}
              : { taskId: approval.requester.taskId }),
            action: approval.action.name,
            summary: approval.action.summary,
            ...data,
          },
        };
        await store.appendEvents(approval.approvalId, [event]);
        break;
      } catch (error) {
        if (!isRunStoreError(error, "SEQUENCE_CONFLICT")) {
          reportError(error);
          break;
        }
      }
    }
    for (const listener of listeners) {
      try {
        await listener({ type, approval });
      } catch (error) {
        reportError(error);
      }
    }
  }

  async function expireIfDue(approval: ApprovalRequest): Promise<ApprovalRequest> {
    if (
      approval.status !== "pending" ||
      approval.expiresAt === undefined ||
      Date.parse(approval.expiresAt) > now().getTime()
    ) {
      return approval;
    }
    const { approval: next, changed } = await update(approval.approvalId, (current) =>
      current.status === "pending"
        ? { status: "expired", closedReason: "Nobody decided before the request expired." }
        : undefined,
    );
    if (changed) {
      await record("approval.expired", next, { expiresAt: approval.expiresAt });
    }
    return next;
  }

  async function scan(
    filter: ApprovalListFilter,
    visit: (approval: ApprovalRequest) => Promise<boolean>,
  ): Promise<void> {
    const statuses =
      filter.status === undefined
        ? undefined
        : typeof filter.status === "string"
          ? [filter.status]
          : filter.status;
    // Expiry is lazy, so a stored `created` record may come back as expired.
    const envelopeStatuses =
      statuses === undefined
        ? undefined
        : [
            ...new Set(
              statuses.flatMap((status) =>
                status === "expired"
                  ? [...envelopeStatusesFor("expired"), "created" as const]
                  : envelopeStatusesFor(status),
              ),
            ),
          ];
    let createdBefore = filter.createdBefore;
    for (;;) {
      const page = await store.listRuns({
        rootScopeId: APPROVALS_SCOPE_ID,
        limit: 200,
        ...(envelopeStatuses === undefined ? {} : { status: envelopeStatuses }),
        ...(createdBefore === undefined ? {} : { createdBefore }),
      });
      for (const run of page) {
        const approval = runToApproval(run);
        if (approval === undefined) {
          continue;
        }
        if (!(await visit(approval))) {
          return;
        }
      }
      if (page.length < 200) {
        return;
      }
      createdBefore = page[page.length - 1]?.createdAt;
    }
  }

  const service: ApprovalServiceContract = {
    kind: "approvals",

    async request(input) {
      const approvalId = input.approvalId ?? createId();
      if (approvalId.length === 0 || approvalId.length > 200) {
        throw new ApprovalError("INVALID_INPUT", "Approval ids must be 1 to 200 characters.");
      }
      const existing = await load(approvalId);
      if (existing !== undefined) {
        return expireIfDue(existing);
      }
      const timestamp = now();
      const status = input.status ?? "pending";
      const serialized =
        input.action.input === undefined ? undefined : JSON.stringify(input.action.input);
      const keepInput = serialized !== undefined && Buffer.byteLength(serialized) <= maxInputBytes;
      const ttlMs = input.ttlMs ?? defaultTtlMs;
      const expiresAt =
        status !== "pending"
          ? undefined
          : (input.expiresAt ?? new Date(timestamp.getTime() + ttlMs).toISOString());
      const stored: StoredApproval = {
        approvalId,
        status,
        requester: input.requester,
        action: {
          kind: input.action.kind,
          name: input.action.name,
          ...(keepInput ? { input: input.action.input } : {}),
          ...(serialized !== undefined && !keepInput ? { inputOmitted: true } : {}),
          inputDigest:
            input.action.inputDigest ?? approvalInputDigest(input.action.name, input.action.input),
          effects: [...input.action.effects],
          ...(input.action.reversibility === undefined
            ? {}
            : { reversibility: input.action.reversibility }),
          summary: input.action.summary,
        },
        policy: input.policy,
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString(),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
      const { envelope, metadata } = toRun(stored);
      try {
        const saved = await store.saveRun({ envelope, metadata, expectedVersion: 0 });
        const created = { ...stored, version: saved.version };
        await record(
          status === "denied" ? "approval.denied" : "approval.requested",
          created,
          {
            effects: created.action.effects,
            reason: created.policy.reason,
            ...(created.policy.ruleId === undefined ? {} : { ruleId: created.policy.ruleId }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
          status === "denied" ? POLICY_ACTOR : input.requester.actor,
        );
        return created;
      } catch (error) {
        if (isRunStoreError(error, "VERSION_CONFLICT")) {
          const raced = await load(approvalId);
          if (raced !== undefined) {
            return raced;
          }
        }
        throw error;
      }
    },

    async get(approvalId) {
      const approval = await load(approvalId);
      return approval === undefined ? undefined : expireIfDue(approval);
    },

    async list(filter = {}) {
      const limit = filter.limit ?? 100;
      const results: ApprovalRequest[] = [];
      await scan(filter, async (stored) => {
        const approval = await expireIfDue(stored);
        if (matchesFilter(approval, filter)) {
          results.push(approval);
        }
        return results.length < limit;
      });
      return results;
    },

    async decide(input) {
      const { approval, changed } = await update(input.approvalId, (current) => {
        if (current.status !== "pending") {
          return undefined;
        }
        if (current.expiresAt !== undefined && Date.parse(current.expiresAt) <= now().getTime()) {
          return { status: "expired", closedReason: "Nobody decided before the request expired." };
        }
        return {
          status: input.decision,
          decision: {
            decision: input.decision,
            decidedBy: input.actor,
            decidedAt: now().toISOString(),
            ...(input.comment === undefined || input.comment.trim() === ""
              ? {}
              : { comment: input.comment.trim() }),
          },
        };
      });
      if (!changed) {
        throw new ApprovalError(
          "ALREADY_DECIDED",
          `Approval ${input.approvalId} is already ${approval.status}.`,
        );
      }
      if (approval.status === "expired") {
        await record("approval.expired", approval, { expiresAt: approval.expiresAt });
        throw new ApprovalError("ALREADY_DECIDED", `Approval ${input.approvalId} has expired.`);
      }
      await record(
        input.decision === "approved" ? "approval.approved" : "approval.rejected",
        approval,
        approval.decision?.comment === undefined ? {} : { comment: approval.decision.comment },
        input.actor,
      );
      return approval;
    },

    async cancel(approvalId, reason = "The work that asked for it was cancelled.") {
      const { approval, changed } = await update(approvalId, (current) =>
        current.status === "pending" ? { status: "cancelled", closedReason: reason } : undefined,
      );
      if (!changed) {
        return undefined;
      }
      await record("approval.cancelled", approval, { reason });
      return approval;
    },

    async claimExecution(approvalId) {
      let refusal: ApprovalError | undefined;
      const { approval, changed } = await update(approvalId, (current) => {
        if (current.status !== "approved") {
          refusal = new ApprovalError(
            "NOT_APPROVED",
            `Approval ${approvalId} is ${current.status}, not approved.`,
          );
          return undefined;
        }
        if (current.execution !== undefined) {
          refusal = new ApprovalError(
            "ALREADY_EXECUTED",
            `The action approved by ${approvalId} already ran (${current.execution.state}).`,
          );
          return undefined;
        }
        return { execution: { state: "started", startedAt: now().toISOString() } };
      });
      if (!changed) {
        throw (
          refusal ?? new ApprovalError("NOT_APPROVED", `Approval ${approvalId} is not approved.`)
        );
      }
      return approval;
    },

    async completeExecution(input: CompleteApprovalExecutionInput) {
      const { approval, changed } = await update(input.approvalId, (current) => {
        if (current.execution?.state !== "started") {
          return undefined;
        }
        return {
          execution: {
            ...current.execution,
            state: input.state,
            completedAt: now().toISOString(),
            ...(input.error === undefined ? {} : { error: input.error }),
            ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
          },
        };
      });
      if (changed) {
        await record(
          input.state === "succeeded" ? "approval.executed" : "approval.execution.failed",
          approval,
          {
            ...(input.state === "uncertain" ? { uncertain: true } : {}),
            ...(input.error === undefined ? {} : { error: input.error }),
            ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
          },
        );
      }
      return approval;
    },

    async expireDue() {
      let expired = 0;
      await scan({ status: "pending" }, async (approval) => {
        if ((await expireIfDue(approval)).status === "expired") {
          expired += 1;
        }
        return true;
      });
      return expired;
    },

    async history(approvalId) {
      return store.readEvents(approvalId);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return service;
}
