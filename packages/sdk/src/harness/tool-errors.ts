import type { JsonObject } from "../contracts/shared.js";
import type {
  ToolErrorEnvelope,
  ToolErrorKind,
  ToolErrorRawCause,
  ToolRecoveryHint,
  ToolTimeoutBudget,
} from "./types.js";

export interface CreateToolErrorEnvelopeInput {
  readonly kind: ToolErrorKind;
  readonly safeMessage: string;
  readonly retryable?: boolean;
  readonly transient?: boolean;
  readonly userActionable?: boolean;
  readonly rawCause?: unknown;
  readonly remediationHints?: readonly ToolRecoveryHint[];
  readonly timeoutBudget?: ToolTimeoutBudget;
  readonly metadata?: JsonObject;
}

export interface NormalizeToolErrorInput {
  readonly error: unknown;
  readonly kind?: ToolErrorKind;
  readonly safeMessage?: string;
  readonly remediationHints?: readonly ToolRecoveryHint[];
  readonly timeoutBudget?: ToolTimeoutBudget;
  readonly metadata?: JsonObject;
}

export class GenericAIToolError extends Error {
  readonly envelope: ToolErrorEnvelope;
  override readonly cause?: unknown;

  constructor(envelope: ToolErrorEnvelope, options: { readonly cause?: unknown } = {}) {
    super(envelope.safeMessage);
    this.name = "GenericAIToolError";
    this.envelope = envelope;
    this.cause = options.cause;
  }
}

function defaultRetryable(kind: ToolErrorKind): boolean {
  return kind === "timeout" || kind === "upstream_unavailable" || kind === "rate_limited";
}

function defaultTransient(kind: ToolErrorKind): boolean {
  return kind === "timeout" || kind === "upstream_unavailable" || kind === "rate_limited";
}

function defaultUserActionable(kind: ToolErrorKind): boolean {
  return (
    kind === "auth_required" ||
    kind === "invalid_input" ||
    kind === "policy_blocked" ||
    kind === "budget_exhausted"
  );
}

function rawCauseFor(error: unknown): ToolErrorRawCause | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }

  if (error instanceof Error) {
    const source = error as Error & {
      readonly code?: unknown;
      readonly status?: unknown;
      readonly statusCode?: unknown;
    };
    const code = typeof source.code === "string" ? source.code : undefined;
    const status =
      typeof source.status === "number"
        ? source.status
        : typeof source.statusCode === "number"
          ? source.statusCode
          : undefined;

    return Object.freeze({
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
      ...(status === undefined ? {} : { status }),
    });
  }

  if (typeof error === "object") {
    const source = error as {
      readonly name?: unknown;
      readonly message?: unknown;
      readonly code?: unknown;
      readonly status?: unknown;
      readonly statusCode?: unknown;
    };
    const name = typeof source.name === "string" ? source.name : undefined;
    const message = typeof source.message === "string" ? source.message : undefined;
    const code = typeof source.code === "string" ? source.code : undefined;
    const status =
      typeof source.status === "number"
        ? source.status
        : typeof source.statusCode === "number"
          ? source.statusCode
          : undefined;

    return Object.freeze({
      ...(name === undefined ? {} : { name }),
      ...(message === undefined ? {} : { message }),
      ...(code === undefined ? {} : { code }),
      ...(status === undefined ? {} : { status }),
    });
  }

  return Object.freeze({
    message: String(error),
  });
}

function messageFor(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
}

function classifyToolError(error: unknown): ToolErrorKind {
  if (error instanceof GenericAIToolError) {
    return error.envelope.kind;
  }

  const raw = rawCauseFor(error);
  const status = raw?.status;
  const text = `${raw?.name ?? ""} ${raw?.code ?? ""} ${raw?.message ?? messageFor(error)}`;
  const normalized = text.toLowerCase();

  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "timeout";
  }

  if (
    normalized.includes("budget") ||
    normalized.includes("quota exhausted") ||
    normalized.includes("call limit")
  ) {
    return "budget_exhausted";
  }

  if (
    normalized.includes("policy") ||
    normalized.includes("blocked") ||
    normalized.includes("not on the allow list") ||
    normalized.includes("internal host")
  ) {
    return "policy_blocked";
  }

  if (status === 401 || status === 403 || normalized.includes("auth")) {
    return "auth_required";
  }

  if (status === 404 || normalized.includes("not found")) {
    return "not_found";
  }

  if (status === 429 || normalized.includes("rate limit")) {
    return "rate_limited";
  }

  if (
    (status !== undefined && status >= 500) ||
    normalized.includes("unavailable") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound")
  ) {
    return "upstream_unavailable";
  }

  if (
    normalized.includes("invalid") ||
    normalized.includes("must be") ||
    normalized.includes("required")
  ) {
    return "invalid_input";
  }

  return "unknown";
}

export function createToolErrorEnvelope(
  input: CreateToolErrorEnvelopeInput,
): ToolErrorEnvelope {
  const rawCause = rawCauseFor(input.rawCause);

  return Object.freeze({
    kind: input.kind,
    safeMessage: input.safeMessage,
    retryable: input.retryable ?? defaultRetryable(input.kind),
    transient: input.transient ?? defaultTransient(input.kind),
    userActionable: input.userActionable ?? defaultUserActionable(input.kind),
    ...(rawCause === undefined ? {} : { rawCause }),
    ...(input.remediationHints === undefined
      ? {}
      : { remediationHints: Object.freeze([...input.remediationHints]) }),
    ...(input.timeoutBudget === undefined ? {} : { timeoutBudget: input.timeoutBudget }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
}

export function normalizeToolError(input: NormalizeToolErrorInput): ToolErrorEnvelope {
  if (input.error instanceof GenericAIToolError && input.kind === undefined) {
    return input.error.envelope;
  }

  const kind = input.kind ?? classifyToolError(input.error);
  return createToolErrorEnvelope({
    kind,
    safeMessage: input.safeMessage ?? messageFor(input.error),
    rawCause: input.error,
    ...(input.remediationHints === undefined ? {} : { remediationHints: input.remediationHints }),
    ...(input.timeoutBudget === undefined ? {} : { timeoutBudget: input.timeoutBudget }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
}
