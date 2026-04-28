import type { JsonArray, JsonObject, JsonValue } from "@generic-ai/sdk";
import type { ObservabilityPayloadSummary } from "./types.js";

export interface ObservabilityRedactionOptions {
  readonly posture?: "metadata_only" | "redacted";
  readonly maxStringBytes?: number;
  readonly allowKeys?: readonly string[];
  readonly now?: () => string;
}

export class ObservabilityRedactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObservabilityRedactionError";
  }
}

const SECRET_KEY_PATTERN =
  /(api[_-]?key|authorization|bearer|client[_-]?secret|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE_PATTERN =
  /(bearer\s+[a-z0-9._~+/=-]{12,}|sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const ENV_ASSIGNMENT_PATTERN =
  /^\s*[A-Z0-9_]*(API_KEY|AUTH|PASSWORD|SECRET|TOKEN)[A-Z0-9_]*\s*=/im;

export function summarizePayload(
  value: unknown,
  options: ObservabilityRedactionOptions = {},
): ObservabilityPayloadSummary {
  try {
    const posture = options.posture ?? "metadata_only";
    if (posture === "metadata_only") {
      return metadataOnlySummary(value);
    }

    const redacted = redactJsonValue(value, options);
    return Object.freeze({
      posture: "redacted",
      kind: kindOf(value),
      byteSize: byteSize(redacted),
      summary: "Payload redacted with secret-pattern filtering.",
      redacted: true,
      truncated: containsTruncation(redacted),
      metadata: Object.freeze({
        redacted,
      }) as JsonObject,
    });
  } catch (error) {
    return Object.freeze({
      posture: "redacted",
      kind: kindOf(value),
      byteSize: 0,
      summary: "Payload redaction failed; content was discarded.",
      redacted: true,
      truncated: false,
      metadata: Object.freeze({
        redactionFailed: true,
        errorName: error instanceof Error ? error.name : "unknown",
      }) as JsonObject,
    });
  }
}

export function metadataOnlySummary(value: unknown): ObservabilityPayloadSummary {
  const metadata = metadataFor(value);

  return Object.freeze({
    posture: "metadata_only",
    kind: kindOf(value),
    byteSize: byteSize(value),
    summary: metadataSummary(value),
    redacted: true,
    truncated: false,
    metadata,
  });
}

export function redactJsonValue(
  value: unknown,
  options: ObservabilityRedactionOptions = {},
): JsonValue {
  return redactJsonValueAtPath(value, [], options);
}

function redactJsonValueAtPath(
  value: unknown,
  path: readonly string[],
  options: ObservabilityRedactionOptions,
): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value, options);
  }

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return "[binary payload omitted]";
  }

  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item, index) => redactJsonValueAtPath(item, [...path, String(index)], options)),
    ) as JsonArray;
  }

  if (typeof value === "object" && value !== null) {
    const out: Record<string, JsonValue> = {};
    const input = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(input)) {
      const allowed = options.allowKeys?.includes(key) ?? false;
      out[key] =
        !allowed && SECRET_KEY_PATTERN.test(key)
          ? "[redacted]"
          : redactJsonValueAtPath(child, [...path, key], options);
    }

    return Object.freeze(out) as JsonObject;
  }

  return String(value);
}

function redactString(value: string, options: ObservabilityRedactionOptions): string {
  const maxBytes = options.maxStringBytes ?? 4096;
  if (SECRET_VALUE_PATTERN.test(value) || ENV_ASSIGNMENT_PATTERN.test(value)) {
    return "[redacted]";
  }

  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}[truncated]`;
}

function metadataFor(value: unknown): JsonObject {
  if (value === null) {
    return Object.freeze({ valueKind: "null" }) as JsonObject;
  }

  if (Array.isArray(value)) {
    return Object.freeze({
      valueKind: "array",
      itemCount: value.length,
    }) as JsonObject;
  }

  if (value instanceof Uint8Array) {
    return Object.freeze({
      valueKind: "binary",
      byteLength: value.byteLength,
    }) as JsonObject;
  }

  if (value instanceof ArrayBuffer) {
    return Object.freeze({
      valueKind: "binary",
      byteLength: value.byteLength,
    }) as JsonObject;
  }

  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>);
    return Object.freeze({
      valueKind: "object",
      keyCount: keys.length,
      keys: Object.freeze(keys.slice(0, 20)) as JsonArray,
    }) as JsonObject;
  }

  return Object.freeze({
    valueKind: typeof value,
  }) as JsonObject;
}

function metadataSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return `Array payload with ${value.length} items; content omitted.`;
  }

  if (typeof value === "object" && value !== null) {
    return `Object payload with ${Object.keys(value as Record<string, unknown>).length} keys; content omitted.`;
  }

  return `${kindOf(value)} payload; content omitted.`;
}

function containsTruncation(value: JsonValue): boolean {
  if (typeof value === "string") {
    return value.endsWith("[truncated]");
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsTruncation(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsTruncation(item));
  }

  return false;
}

function kindOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return "binary";
  }
  return typeof value;
}

export function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new ObservabilityRedactionError("Value cannot be serialized for byte accounting.", {
      cause: error,
    });
  }
}
