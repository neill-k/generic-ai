import { createHash } from "node:crypto";

import {
  type AgentTaskExecutionInput,
  type ApprovalPolicy,
  type ApprovalPolicyVerdict,
  type ApprovalRequest,
  type ApprovalRequester,
  type ApprovalServiceContract,
  type Awaitable,
  approvalInputDigest,
  canonicalJson,
  createToolErrorEnvelope,
  DEFAULT_APPROVAL_POLICY,
  evaluateApprovalPolicy,
  GenericAIToolError,
  getAgentHarnessToolEffects,
  getAgentHarnessToolReversibility,
  isApprovalError,
  type JsonValue,
  type RunActor,
  TOOL_EFFECT_NOT_PERFORMED_KEY,
} from "@generic-ai/sdk";

/**
 * Wraps agent tools so every call goes through the approval policy.
 *
 * - `allow`: the tool runs.
 * - `deny`: the call fails with the policy's reason, recorded as a `denied` request.
 * - `require_approval`: the exact call becomes a durable request. In `suspend`
 *   mode (the delegation cascade) the agent is told to end its turn; the task
 *   waits and resumes with the owner's decision. In `wait` mode (a single
 *   interactive run) the call blocks until the owner decides or the wait times out.
 *
 * When the owner approved a request, the same call (same tool, same input) runs
 * once. A different input, or a second identical call after it ran, needs a new
 * approval.
 */
export type ApprovalGateMode = "suspend" | "wait";

export interface CreateApprovalGateOptions {
  readonly service: ApprovalServiceContract;
  readonly requester: ApprovalRequester;
  /** Defaults to {@link DEFAULT_APPROVAL_POLICY}. */
  readonly policy?: ApprovalPolicy;
  /** Defaults to `suspend`. */
  readonly mode?: ApprovalGateMode;
  /** How long `wait` mode blocks before failing the call. Defaults to 10 minutes. */
  readonly waitTimeoutMs?: number;
  /** How often `wait` mode re-reads the request. Defaults to 1 second. */
  readonly pollIntervalMs?: number;
  /** One-line description of a call for the owner. */
  readonly summarize?: (toolName: string, input: JsonValue) => string;
  readonly onPending?: (approval: ApprovalRequest) => Awaitable<void>;
  readonly signal?: AbortSignal;
}

export interface ToolBindingsLike {
  readonly terminalTools?: { readonly tool: unknown };
  readonly fileTools?: { readonly piTools: readonly unknown[] };
  readonly customTools?: readonly unknown[];
  readonly mcp?: { readonly harnessTools?: () => Awaitable<readonly unknown[]> };
}

export interface ApprovalGate {
  readonly requester: ApprovalRequester;
  readonly policy: ApprovalPolicy;
  readonly mode: ApprovalGateMode;
  wrapTool<TTool>(tool: TTool): TTool;
  /** Wraps every tool in a capability bindings object (terminal, files, custom and MCP tools). */
  wrapBindings<TBindings extends ToolBindingsLike>(bindings: TBindings): TBindings;
  /** Requests this gate left pending (suspend mode). */
  pending(): readonly ApprovalRequest[];
}

/** Thrown in `wait` mode when the owner does not decide in time. */
export class ApprovalWaitTimeoutError extends Error {
  constructor(readonly approval: ApprovalRequest) {
    super(
      `The owner has not decided approval ${approval.approvalId} yet. The request stays open; do not retry this action now.`,
    );
    this.name = "ApprovalWaitTimeoutError";
  }
}

const MAX_OCCURRENCES = 100;
const SUMMARY_INPUT_CHARS = 300;

type ExecutableTool = { readonly name?: string; execute: (...args: unknown[]) => unknown };

function isExecutable(tool: unknown): tool is ExecutableTool {
  return (
    typeof tool === "object" &&
    tool !== null &&
    typeof (tool as { execute?: unknown }).execute === "function"
  );
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function resultText(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }
  const content = (result as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" && part !== null && part.type === "text",
      )
      .map((part) => part.text)
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function defaultSummary(toolName: string, input: JsonValue): string {
  return `${toolName} ${clip(canonicalJson(input), SUMMARY_INPUT_CHARS)}`;
}

export function describeActor(actor: RunActor | undefined): string {
  if (actor === undefined) {
    return "the owner";
  }
  return actor.displayName ?? actor.subjectId;
}

/** Deterministic request id for the n-th identical call within one task (or run). */
export function approvalIdFor(scopeKey: string, digest: string, occurrence: number): string {
  const key = createHash("sha256").update(scopeKey).update("\u0000").update(digest).digest("hex");
  return `apr-${key.slice(0, 24)}-${occurrence}`;
}

export function pendingApprovalMessage(approval: ApprovalRequest): string {
  return [
    `This action needs the owner's approval before it can run (approval request ${approval.approvalId}).`,
    `Why: ${approval.policy.reason}`,
    "Do not call this tool again now, and do not try to get the same result another way.",
    "Finish any other work that does not depend on it, then end your turn with a short note saying what you are waiting for.",
    "You will get a new turn with the owner's decision.",
  ].join("\n");
}

/** Same shape and meaning as the effect journal's refusal of an unreported call (ADR 0059). */
function uncertainError(approval: ApprovalRequest): GenericAIToolError {
  return new GenericAIToolError(
    createToolErrorEnvelope({
      kind: "unknown",
      safeMessage:
        `An earlier attempt started the action approved by ${approval.approvalId} ` +
        `(${approval.action.summary}) and stopped before it reported a result, so it may already ` +
        "have happened. It was not run again. Check whether it took effect before you decide to " +
        "retry; calling it again asks the owner for a new approval.",
      retryable: false,
      userActionable: true,
      metadata: {
        toolName: approval.action.name,
        approvalId: approval.approvalId,
        uncertain: true,
      },
    }),
  );
}

function rejectedMessage(approval: ApprovalRequest): string {
  const who = describeActor(approval.decision?.decidedBy);
  const comment = approval.decision?.comment;
  return `${who} rejected this action (approval ${approval.approvalId})${
    comment === undefined ? "." : `: ${comment}`
  } Do not try it again; choose another approach or explain why the task cannot be done.`;
}

export function createApprovalGate(options: CreateApprovalGateOptions): ApprovalGate {
  const service = options.service;
  const policy = options.policy ?? DEFAULT_APPROVAL_POLICY;
  const mode = options.mode ?? "suspend";
  const requester = options.requester;
  const scopeKey = requester.taskId ?? requester.runId ?? requester.agentId;
  const waitTimeoutMs = options.waitTimeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const summarize = options.summarize ?? defaultSummary;
  const pendingRequests = new Map<string, ApprovalRequest>();

  async function markPending(approval: ApprovalRequest) {
    pendingRequests.set(approval.approvalId, approval);
    await options.onPending?.(approval);
  }

  async function waitForDecision(approval: ApprovalRequest): Promise<ApprovalRequest> {
    const deadline = Date.now() + waitTimeoutMs;
    let current = approval;
    while (current.status === "pending") {
      if (options.signal?.aborted) {
        throw new Error(`Stopped waiting for approval ${approval.approvalId}.`);
      }
      if (Date.now() >= deadline) {
        throw new ApprovalWaitTimeoutError(current);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      current = (await service.get(approval.approvalId)) ?? current;
    }
    return current;
  }

  async function runApproved(
    approval: ApprovalRequest,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    try {
      await service.claimExecution(approval.approvalId);
    } catch (error) {
      if (isApprovalError(error, "ALREADY_EXECUTED")) {
        throw uncertainError(approval);
      }
      throw error;
    }
    try {
      const result = await execute();
      const text = resultText(result);
      await service.completeExecution({
        approvalId: approval.approvalId,
        state: "succeeded",
        ...(text === undefined ? {} : { resultSummary: clip(text, 500) }),
      });
      return result;
    } catch (error) {
      await service.completeExecution({
        approvalId: approval.approvalId,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function settle(
    approval: ApprovalRequest,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    let current = approval;
    if (current.status === "pending") {
      if (mode === "suspend") {
        await markPending(current);
        // Not an effect: the journal (ADR 0059) records it as not performed, so a retry asks again.
        return textResult(pendingApprovalMessage(current), {
          approvalId: current.approvalId,
          status: "pending",
          [TOOL_EFFECT_NOT_PERFORMED_KEY]: true,
        });
      }
      current = await waitForDecision(current);
    }
    switch (current.status) {
      case "approved":
        return runApproved(current, execute);
      case "rejected":
        throw new Error(rejectedMessage(current));
      case "expired":
        throw new Error(
          `Approval ${current.approvalId} expired before the owner decided. Ask again only if the action is still needed.`,
        );
      default:
        throw new Error(`Approval ${current.approvalId} was ${current.status}.`);
    }
  }

  async function gated(
    tool: ExecutableTool,
    args: unknown[],
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    const toolName = tool.name?.trim() || "unknown-tool";
    const effects = getAgentHarnessToolEffects(tool);
    const reversibility = getAgentHarnessToolReversibility(tool);
    const verdict: ApprovalPolicyVerdict = evaluateApprovalPolicy(policy, {
      toolName,
      effects,
      ...(reversibility === undefined ? {} : { reversibility }),
      agentId: requester.agentId,
      ...(requester.role === undefined ? {} : { role: requester.role }),
    });
    if (verdict.decision === "allow") {
      return execute();
    }

    const input = toJson(args[1]);
    const digest = approvalInputDigest(toolName, input);
    const action = {
      kind: "tool.call" as const,
      name: toolName,
      input,
      inputDigest: digest,
      effects,
      ...(reversibility === undefined ? {} : { reversibility }),
      summary: summarize(toolName, input),
    };
    const policyRef = {
      ...(verdict.ruleId === undefined ? {} : { ruleId: verdict.ruleId }),
      reason: verdict.reason,
    };

    if (verdict.decision === "deny") {
      await service.request({ requester, action, policy: policyRef, status: "denied" });
      throw new Error(`Policy blocked ${toolName}: ${verdict.reason}`);
    }

    for (let occurrence = 1; occurrence <= MAX_OCCURRENCES; occurrence += 1) {
      const approvalId = approvalIdFor(scopeKey, digest, occurrence);
      const existing = await service.get(approvalId);
      if (existing === undefined) {
        const created = await service.request({
          approvalId,
          requester,
          action,
          policy: policyRef,
          ...(verdict.ttlMs === undefined ? {} : { ttlMs: verdict.ttlMs }),
        });
        return settle(created, execute);
      }
      if (existing.status === "pending" || existing.status === "rejected") {
        return settle(existing, execute);
      }
      if (existing.status === "approved" && existing.execution === undefined) {
        return settle(existing, execute);
      }
      if (existing.status === "approved" && existing.execution?.state === "started") {
        // An earlier turn claimed this approval and stopped before reporting back. Within one
        // turn the effect journal (ADR 0059) catches this first; across turns the claim does.
        // Either way the action is not repeated: record it as uncertain and tell the agent once.
        await service.completeExecution({
          approvalId: existing.approvalId,
          state: "uncertain",
          error: "The attempt that ran it stopped before reporting a result.",
        });
        throw uncertainError(existing);
      }
      // Already ran, uncertain, expired, or cancelled: an identical new call needs a new request.
    }
    throw new Error(`Too many approval requests for the same ${toolName} call.`);
  }

  function wrapTool<TTool>(tool: TTool): TTool {
    if (!isExecutable(tool)) {
      return tool;
    }
    const original = tool.execute.bind(tool);
    const wrapped = Object.create(Object.getPrototypeOf(tool)) as ExecutableTool;
    // Copy everything but `execute`: a frozen tool's descriptors are not configurable, so
    // copying `execute` first would make the replacement below throw.
    const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(tool);
    Reflect.deleteProperty(descriptors, "execute");
    Object.defineProperties(wrapped, descriptors);
    Object.defineProperty(wrapped, "execute", {
      enumerable: true,
      configurable: true,
      writable: true,
      value(...args: unknown[]) {
        return gated(tool, args, async () => original(...args));
      },
    });
    return wrapped as TTool;
  }

  function wrapBindings<TBindings extends ToolBindingsLike>(bindings: TBindings): TBindings {
    const mcp = bindings.mcp;
    const harnessTools = mcp?.harnessTools;
    return {
      ...bindings,
      ...(bindings.terminalTools === undefined
        ? {}
        : {
            terminalTools: {
              ...bindings.terminalTools,
              tool: wrapTool(bindings.terminalTools.tool),
            },
          }),
      ...(bindings.fileTools === undefined
        ? {}
        : {
            fileTools: {
              ...bindings.fileTools,
              piTools: bindings.fileTools.piTools.map((tool) => wrapTool(tool)),
            },
          }),
      ...(bindings.customTools === undefined
        ? {}
        : { customTools: bindings.customTools.map((tool) => wrapTool(tool)) }),
      ...(mcp === undefined || harnessTools === undefined
        ? {}
        : {
            mcp: bindMcp(mcp, async () =>
              (await harnessTools.call(mcp)).map((tool) => wrapTool(tool)),
            ),
          }),
    };
  }

  return Object.freeze({
    requester,
    policy,
    mode,
    wrapTool,
    wrapBindings,
    pending: () => Object.freeze([...pendingRequests.values()]),
  });
}

/** Keeps the MCP capability's other methods bound to the original object. */
function bindMcp<TMcp extends object>(
  mcp: TMcp,
  harnessTools: () => Promise<readonly unknown[]>,
): TMcp {
  return new Proxy(mcp, {
    get(target, property, receiver) {
      if (property === "harnessTools") {
        return harnessTools;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The requester for one turn of a delegated task. */
export function approvalRequesterForTask(
  input: AgentTaskExecutionInput,
  actor?: RunActor,
): ApprovalRequester {
  return {
    agentId: input.agentId,
    role: input.role,
    taskId: input.taskId,
    rootTaskId: input.rootTaskId,
    runId: input.attemptRunId,
    ...(actor === undefined ? {} : { actor }),
  };
}
