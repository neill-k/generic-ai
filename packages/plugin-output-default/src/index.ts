import { inspect } from "node:util";

export const name = "@generic-ai/plugin-output-default" as const;
export const kind = "output" as const;

export type DefaultOutputStatus = "completed" | "failed" | "cancelled";

export interface DefaultOutputPluginOptions {
  readonly now?: () => string | number | Date;
  readonly render?: (value: unknown) => string;
  readonly summaryLength?: number;
}

export interface DefaultOutputRecord<TPayload = unknown> {
  readonly plugin: typeof name;
  readonly kind: typeof kind;
  readonly status: DefaultOutputStatus;
  readonly summary: string;
  readonly text: string;
  readonly payload: TPayload;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly producedAt: string;
}

export interface DefaultOutputPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  render(value: unknown): string;
  finalize<TPayload = unknown>(value: TPayload): DefaultOutputRecord<TPayload>;
}

export const defaultOutputPlugin = createDefaultOutputPlugin();

export function createDefaultOutputPlugin(
  options: DefaultOutputPluginOptions = {},
): DefaultOutputPlugin {
  const render = options.render ?? renderDefaultOutput;
  const summaryLength = normalizeSummaryLength(options.summaryLength);

  return Object.freeze({
    name,
    kind,
    render(value: unknown): string {
      return render(value);
    },
    finalize<TPayload = unknown>(value: TPayload): DefaultOutputRecord<TPayload> {
      return finalizeDefaultOutput(value, {
        render,
        summaryLength,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    },
  });
}

export function renderDefaultOutput(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  if (value instanceof Error) {
    return formatError(value);
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  if (isPlainObject(value)) {
    const textLike = extractTextLikeField(value);
    if (textLike !== undefined) {
      return textLike;
    }
  }

  const clone = cloneValue(value);

  try {
    const json = JSON.stringify(clone, undefined, 2);
    if (json !== undefined) {
      return json;
    }
  } catch {
    // Fall back to an inspect-based rendering for values JSON cannot represent.
  }

  return inspect(clone, {
    depth: 6,
    breakLength: 80,
    sorted: true,
  });
}

export function finalizeDefaultOutput<TPayload = unknown>(
  value: TPayload,
  options: DefaultOutputPluginOptions = {},
): DefaultOutputRecord<TPayload> {
  const text = options.render ? options.render(value) : renderDefaultOutput(value);
  const summary = summarizeText(text, normalizeSummaryLength(options.summaryLength));
  const payload = cloneValue(value);
  const metadata = extractMetadata(value);

  return Object.freeze({
    plugin: name,
    kind,
    status: inferStatus(value),
    summary,
    text,
    payload,
    metadata,
    producedAt: normalizeTimestamp(options.now),
  });
}

function inferStatus(value: unknown): DefaultOutputStatus {
  if (value instanceof Error) {
    return value.name === "AbortError" ? "cancelled" : "failed";
  }

  if (!isPlainObject(value)) {
    return "completed";
  }

  const status = value["status"];
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }

  const error = value["error"];
  if (error instanceof Error) {
    return error.name === "AbortError" ? "cancelled" : "failed";
  }

  return "completed";
}

function extractMetadata(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value) || !isPlainObject(value["metadata"])) {
    return Object.freeze({});
  }

  return Object.freeze(clonePlainObject(value["metadata"]));
}

function extractTextLikeField(value: Record<string, unknown>): string | undefined {
  const candidates = [value["summary"], value["text"], value["message"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return undefined;
}

function normalizeSummaryLength(summaryLength: number | undefined): number {
  if (summaryLength === undefined) {
    return 120;
  }

  if (!Number.isInteger(summaryLength) || summaryLength < 8) {
    throw new TypeError("summaryLength must be an integer of at least 8 characters.");
  }

  return summaryLength;
}

function summarizeText(text: string, summaryLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();

  if (compact.length <= summaryLength) {
    return compact;
  }

  return `${compact.slice(0, summaryLength - 3)}...`;
}

function normalizeTimestamp(now: DefaultOutputPluginOptions["now"]): string {
  const value = now?.() ?? Date.now();

  if (value instanceof Date) {
    return value.toISOString();
  }

  const timestamp = typeof value === "string" ? new Date(value) : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("now() must return a valid date, timestamp, or ISO string.");
  }

  return timestamp.toISOString();
}

function formatError(error: Error): string {
  const name = error.name?.trim() || "Error";
  const message = error.message?.trim();

  return message.length > 0 ? `${name}: ${message}` : name;
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function clonePlainObject(value: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    clone[key] = cloneValue(entry);
  }

  return clone;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
