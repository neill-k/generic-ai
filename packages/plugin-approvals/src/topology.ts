import {
  type ApprovalPolicy,
  type ApprovalRequester,
  type ApprovalServiceContract,
  approvalInputDigest,
  type Awaitable,
  type JsonValue,
  type ProtocolAction,
} from "@generic-ai/sdk";

/**
 * Bridges the topology runner's `request_approval` actions (core
 * `runHarnessTopology({ approve })`) to durable owner approvals. The runner
 * waits in process, so this is for interactive runs; long waits belong in the
 * delegation cascade, which releases its worker while the owner decides.
 */
export interface TopologyApprovalInput {
  readonly runId: string;
  readonly protocol: string;
  readonly step: number;
  readonly action: ProtocolAction;
}

export interface CreateTopologyApproverOptions {
  readonly service: ApprovalServiceContract;
  readonly requester: Omit<ApprovalRequester, "runId"> & { readonly runId?: string };
  /** How long to wait for the owner. Defaults to 10 minutes; a timeout counts as a rejection. */
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Request lifetime. Defaults to the service default. */
  readonly ttlMs?: number;
  readonly policy?: Pick<ApprovalPolicy, "ttlMs">;
  readonly signal?: AbortSignal;
}

export function createTopologyApprover(
  options: CreateTopologyApproverOptions,
): (request: TopologyApprovalInput) => Awaitable<boolean> {
  const waitTimeoutMs = options.waitTimeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  return async (request) => {
    const payload = (request.action.payload ?? {}) as JsonValue;
    const summaryText =
      typeof (payload as { summary?: unknown }).summary === "string"
        ? ((payload as { summary: string }).summary as string)
        : `${request.protocol} step ${request.step}: ${request.action.id}`;
    const ttlMs = options.ttlMs ?? options.policy?.ttlMs;
    let approval = await options.service.request({
      approvalId: `apr-topology-${approvalInputDigest(request.runId, request.action.idempotencyKey).slice(0, 32)}`,
      requester: { ...options.requester, runId: options.requester.runId ?? request.runId },
      action: {
        kind: "topology.action",
        name: request.action.id,
        input: payload,
        effects: [],
        summary: summaryText,
      },
      policy: { reason: `The ${request.protocol} topology asks for sign-off before continuing.` },
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
    const deadline = Date.now() + waitTimeoutMs;
    while (approval.status === "pending" && Date.now() < deadline && !options.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      approval = (await options.service.get(approval.approvalId)) ?? approval;
    }
    return approval.status === "approved";
  };
}
