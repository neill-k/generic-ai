import { createHash } from "node:crypto";

import type { CanonicalEvent } from "../events/taxonomy.js";
import type { RunActor } from "./identity.js";
import type { Awaitable, JsonObject, JsonValue } from "./shared.js";

/**
 * Owner approvals for outward or costly actions.
 *
 * Agents in Generic AI do generic work: they send email, post messages, write
 * to calendars and CRMs, and may spend money. An approval policy decides, per
 * tool call, whether the action runs, is refused, or waits for the owner. A
 * waiting action becomes a durable {@link ApprovalRequest} that the owner
 * approves or rejects; the decision records who made it. An approved action
 * runs at most once. See `docs/decisions/0061-owner-approvals-for-outward-actions.md`.
 */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type ApprovalPolicyDecision = "allow" | "deny" | "require_approval";

export type ApprovalReversibility = "irreversible" | "reversible-with-cost" | "reversible-cheap";

/**
 * Effects that reach outside the agent system. Tools carrying any of them need
 * the owner's approval under {@link DEFAULT_APPROVAL_POLICY}.
 *
 * - `message.send`: sends a message to people (email, chat, posts, replies, invites).
 * - `external.write`: creates, changes or deletes records in an external system.
 * - `payment.spend`: spends money or commits to a purchase.
 * - `mcp.write`: any MCP tool that is not read-only.
 */
export const OUTWARD_EFFECTS: readonly string[] = Object.freeze([
  "message.send",
  "external.write",
  "payment.spend",
  "mcp.write",
]);

export interface ApprovalPolicyRule {
  readonly id: string;
  readonly decision: ApprovalPolicyDecision;
  /** Matches when the tool carries at least one of these effects. */
  readonly effects?: readonly string[];
  /** Tool name patterns; `*` matches any run of characters. */
  readonly tools?: readonly string[];
  /** Persistent agent ids. */
  readonly agents?: readonly string[];
  /** Agent roles (for example `ceo`, `vp`) or harness role ids. */
  readonly roles?: readonly string[];
  readonly reversibility?: readonly ApprovalReversibility[];
  /** Shown to the agent and the owner. */
  readonly reason?: string;
  /** How long a request made under this rule waits before it expires. */
  readonly ttlMs?: number;
}

export interface ApprovalPolicy {
  /** Evaluated in order; the first matching rule wins. */
  readonly rules: readonly ApprovalPolicyRule[];
  /** Used when no rule matches. Defaults to `allow`. */
  readonly defaultDecision?: ApprovalPolicyDecision;
  /** Default request lifetime. */
  readonly ttlMs?: number;
}

export interface ApprovalPolicySubject {
  readonly toolName: string;
  readonly effects: readonly string[];
  readonly reversibility?: ApprovalReversibility;
  readonly agentId?: string;
  readonly role?: string;
}

export interface ApprovalPolicyVerdict {
  readonly decision: ApprovalPolicyDecision;
  readonly ruleId?: string;
  readonly reason: string;
  readonly ttlMs?: number;
}

export const DEFAULT_APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = Object.freeze({
  rules: Object.freeze([
    Object.freeze({
      id: "outward-actions",
      decision: "require_approval" as const,
      effects: OUTWARD_EFFECTS,
      reason:
        "This action reaches outside the company (a message, an external record, a payment, or an MCP write), so the owner signs off first.",
    }),
  ]),
  defaultDecision: "allow" as const,
  ttlMs: DEFAULT_APPROVAL_TTL_MS,
});

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesApprovalPattern(pattern: string, value: string): boolean {
  return pattern === value || (pattern.includes("*") && globToRegExp(pattern).test(value));
}

function ruleMatches(rule: ApprovalPolicyRule, subject: ApprovalPolicySubject): boolean {
  if (rule.effects !== undefined && !rule.effects.some((e) => subject.effects.includes(e))) {
    return false;
  }
  if (
    rule.tools !== undefined &&
    !rule.tools.some((pattern) => matchesApprovalPattern(pattern, subject.toolName))
  ) {
    return false;
  }
  if (
    rule.agents !== undefined &&
    (subject.agentId === undefined || !rule.agents.includes(subject.agentId))
  ) {
    return false;
  }
  if (
    rule.roles !== undefined &&
    (subject.role === undefined || !rule.roles.includes(subject.role))
  ) {
    return false;
  }
  if (
    rule.reversibility !== undefined &&
    (subject.reversibility === undefined || !rule.reversibility.includes(subject.reversibility))
  ) {
    return false;
  }
  return true;
}

export function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  subject: ApprovalPolicySubject,
): ApprovalPolicyVerdict {
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, subject)) {
      continue;
    }
    const ttlMs = rule.ttlMs ?? policy.ttlMs;
    return Object.freeze({
      decision: rule.decision,
      ruleId: rule.id,
      reason: rule.reason ?? defaultReason(rule.decision, subject.toolName),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  }
  const decision = policy.defaultDecision ?? "allow";
  return Object.freeze({
    decision,
    reason: defaultReason(decision, subject.toolName),
    ...(policy.ttlMs === undefined ? {} : { ttlMs: policy.ttlMs }),
  });
}

function defaultReason(decision: ApprovalPolicyDecision, toolName: string): string {
  switch (decision) {
    case "allow":
      return `Policy allows "${toolName}".`;
    case "deny":
      return `Policy does not allow "${toolName}".`;
    default:
      return `Policy requires the owner's approval for "${toolName}".`;
  }
}

const POLICY_DECISIONS = new Set<string>(["allow", "deny", "require_approval"]);
const REVERSIBILITY = new Set<string>(["irreversible", "reversible-with-cost", "reversible-cheap"]);

function stringList(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new TypeError(`${path} must be a list of non-empty strings.`);
  }
  return Object.freeze([...(value as string[])]);
}

function positiveNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive number of milliseconds.`);
  }
  return value;
}

/**
 * Validates an untrusted policy (for example from YAML config). Throws a
 * `TypeError` that names the offending field.
 */
export function parseApprovalPolicy(value: unknown): ApprovalPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Approval policy must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["rules"])) {
    throw new TypeError("Approval policy rules must be a list.");
  }
  const seen = new Set<string>();
  const rules = record["rules"].map((raw, index): ApprovalPolicyRule => {
    const path = `rules[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new TypeError(`${path} must be an object.`);
    }
    const rule = raw as Record<string, unknown>;
    const id = rule["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`${path}.id must be a non-empty string.`);
    }
    if (seen.has(id)) {
      throw new TypeError(`${path}.id "${id}" is used by more than one rule.`);
    }
    seen.add(id);
    const decision = rule["decision"];
    if (typeof decision !== "string" || !POLICY_DECISIONS.has(decision)) {
      throw new TypeError(`${path}.decision must be allow, deny or require_approval.`);
    }
    const reversibility = stringList(rule["reversibility"], `${path}.reversibility`);
    if (reversibility?.some((item) => !REVERSIBILITY.has(item))) {
      throw new TypeError(
        `${path}.reversibility must use irreversible, reversible-with-cost or reversible-cheap.`,
      );
    }
    const reason = rule["reason"];
    if (reason !== undefined && typeof reason !== "string") {
      throw new TypeError(`${path}.reason must be a string.`);
    }
    const effects = stringList(rule["effects"], `${path}.effects`);
    const tools = stringList(rule["tools"], `${path}.tools`);
    const agents = stringList(rule["agents"], `${path}.agents`);
    const roles = stringList(rule["roles"], `${path}.roles`);
    const ttlMs = positiveNumber(rule["ttlMs"], `${path}.ttlMs`);
    return Object.freeze({
      id,
      decision: decision as ApprovalPolicyDecision,
      ...(effects === undefined ? {} : { effects }),
      ...(tools === undefined ? {} : { tools }),
      ...(agents === undefined ? {} : { agents }),
      ...(roles === undefined ? {} : { roles }),
      ...(reversibility === undefined
        ? {}
        : { reversibility: reversibility as readonly ApprovalReversibility[] }),
      ...(reason === undefined ? {} : { reason }),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  });
  const defaultDecision = record["defaultDecision"];
  if (
    defaultDecision !== undefined &&
    (typeof defaultDecision !== "string" || !POLICY_DECISIONS.has(defaultDecision))
  ) {
    throw new TypeError("defaultDecision must be allow, deny or require_approval.");
  }
  const ttlMs = positiveNumber(record["ttlMs"], "ttlMs");
  return Object.freeze({
    rules: Object.freeze(rules),
    ...(defaultDecision === undefined
      ? {}
      : { defaultDecision: defaultDecision as ApprovalPolicyDecision }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * `denied` is set by policy without a human; `approved` and `rejected` are the
 * owner's decisions. `expired` and `cancelled` close a request nobody decided.
 */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "denied"
  | "expired"
  | "cancelled";

export const OPEN_APPROVAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set(["pending"]);

export interface ApprovalRequester {
  /** Agent (or harness role) that asked. */
  readonly agentId: string;
  readonly role?: string;
  /** Durable task the action belongs to, when it runs inside the delegation cascade. */
  readonly taskId?: string;
  readonly rootTaskId?: string;
  /** Harness run (turn) that made the call. */
  readonly runId?: string;
  readonly sessionId?: string;
  /** Who started the work, when known. */
  readonly actor?: RunActor;
}

export type ApprovalActionKind = "tool.call" | "topology.action" | "custom";

export interface ApprovalAction {
  readonly kind: ApprovalActionKind;
  /** Tool name, topology action id, or a custom label. */
  readonly name: string;
  /** The exact input the action will run with, if it fits the size limit. */
  readonly input?: JsonValue;
  /** True when `input` was too large to store and was left out. */
  readonly inputOmitted?: boolean;
  /** SHA-256 over the action name and canonical JSON input. */
  readonly inputDigest: string;
  readonly effects: readonly string[];
  readonly reversibility?: ApprovalReversibility;
  /** One line for the owner, such as `send_email to alice@example.com: "Quarterly update"`. */
  readonly summary: string;
}

export interface ApprovalDecisionRecord {
  readonly decision: "approved" | "rejected";
  readonly decidedBy: RunActor;
  readonly decidedAt: string;
  readonly comment?: string;
}

export interface ApprovalExecutionRecord {
  readonly state: "started" | "succeeded" | "failed";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly resultSummary?: string;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly requester: ApprovalRequester;
  readonly action: ApprovalAction;
  readonly policy: { readonly ruleId?: string; readonly reason: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  /** Set when the owner approved or rejected. */
  readonly decision?: ApprovalDecisionRecord;
  /** Set once an approved action starts running. It never runs twice. */
  readonly execution?: ApprovalExecutionRecord;
  /** Why a request was cancelled or expired. */
  readonly closedReason?: string;
  readonly metadata?: JsonObject;
  /** Store version, for optimistic concurrency. */
  readonly version: number;
}

export interface CreateApprovalRequestInput {
  /** Stable id makes the request idempotent. Generated when omitted. */
  readonly approvalId?: string;
  readonly requester: ApprovalRequester;
  readonly action: Omit<ApprovalAction, "inputDigest"> & { readonly inputDigest?: string };
  readonly policy: { readonly ruleId?: string; readonly reason: string };
  /** `denied` records a policy refusal for the audit trail. Defaults to `pending`. */
  readonly status?: "pending" | "denied";
  readonly ttlMs?: number;
  readonly expiresAt?: string;
  readonly metadata?: JsonObject;
}

export interface ApprovalListFilter {
  readonly status?: ApprovalStatus | readonly ApprovalStatus[];
  readonly taskId?: string;
  readonly rootTaskId?: string;
  readonly agentId?: string;
  readonly runId?: string;
  /** Only requests created strictly before this ISO timestamp (for paging). */
  readonly createdBefore?: string;
  /** Defaults to 100. */
  readonly limit?: number;
}

export interface DecideApprovalInput {
  readonly approvalId: string;
  readonly decision: "approved" | "rejected";
  readonly actor: RunActor;
  readonly comment?: string;
}

export interface CompleteApprovalExecutionInput {
  readonly approvalId: string;
  readonly state: "succeeded" | "failed";
  readonly error?: string;
  readonly resultSummary?: string;
}

export type ApprovalErrorCode =
  | "NOT_FOUND"
  | "ALREADY_DECIDED"
  | "NOT_APPROVED"
  | "ALREADY_EXECUTED"
  | "INVALID_INPUT";

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalError";
    this.code = code;
  }
}

export function isApprovalError(error: unknown, code?: ApprovalErrorCode): error is ApprovalError {
  return (
    error instanceof Error &&
    error.name === "ApprovalError" &&
    (code === undefined || (error as ApprovalError).code === code)
  );
}

export type ApprovalServiceEvent = {
  readonly type: ApprovalLifecycleEventType;
  readonly approval: ApprovalRequest;
};

export type ApprovalLifecycleEventType =
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.denied"
  | "approval.expired"
  | "approval.cancelled"
  | "approval.executed"
  | "approval.execution.failed";

/**
 * Durable approval requests. Implementations must make `decide` and
 * `claimExecution` safe under concurrent callers: a request is decided once,
 * and an approved action is claimed for execution once.
 */
export interface ApprovalServiceContract {
  readonly kind: "approvals";
  /** Creates a request, or returns the existing one with the same id. */
  request(input: CreateApprovalRequestInput): Promise<ApprovalRequest>;
  /** Reads a request. A pending request past its expiry is expired first. */
  get(approvalId: string): Promise<ApprovalRequest | undefined>;
  /** Newest first. */
  list(filter?: ApprovalListFilter): Promise<readonly ApprovalRequest[]>;
  /** Approves or rejects a pending request. Throws `ALREADY_DECIDED` otherwise. */
  decide(input: DecideApprovalInput): Promise<ApprovalRequest>;
  /** Closes a pending request. Returns undefined when it was not pending. */
  cancel(approvalId: string, reason?: string): Promise<ApprovalRequest | undefined>;
  /**
   * Marks an approved request as running. Returns the request when this
   * caller won the claim, and throws `ALREADY_EXECUTED` or `NOT_APPROVED`
   * otherwise. A crash after the claim leaves the action unrepeated.
   */
  claimExecution(approvalId: string): Promise<ApprovalRequest>;
  completeExecution(input: CompleteApprovalExecutionInput): Promise<ApprovalRequest>;
  /** Expires pending requests past their deadline. Returns how many expired. */
  expireDue(): Promise<number>;
  /** The request's audit trail as canonical `approval.*` events, oldest first. */
  history(approvalId: string): Promise<readonly CanonicalEvent[]>;
  /** In-process notifications for live views. Returns an unsubscribe function. */
  subscribe(listener: (event: ApprovalServiceEvent) => Awaitable<void>): () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON with object keys sorted, so equal inputs always serialize the same way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/** SHA-256 hex digest that identifies one exact action. */
export function approvalInputDigest(name: string, input: unknown): string {
  return createHash("sha256")
    .update(name)
    .update("\u0000")
    .update(canonicalJson(input))
    .digest("hex");
}

export function isApprovalDecided(approval: Pick<ApprovalRequest, "status">): boolean {
  return approval.status !== "pending";
}
