export const name = "@generic-ai/plugin-logging-otel" as const;
export const kind = "observability" as const;

export type LogSeverity = "debug" | "info" | "warn" | "error";
export type Jsonish =
  | null
  | boolean
  | number
  | string
  | Jsonish[]
  | { readonly [key: string]: Jsonish };

export interface KernelEvent {
  readonly type: string;
  readonly timestamp?: number | Date;
  readonly message?: string;
  readonly body?: string;
  readonly summary?: string;
  readonly title?: string;
  readonly description?: string;
  readonly level?: string;
  readonly status?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly delegationId?: string;
  readonly durationMs?: number;
  readonly attributes?: Record<string, unknown>;
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

export interface KernelEventSubscriptionSource {
  subscribe(listener: (event: KernelEvent) => void): () => void;
}

export type KernelEventSource =
  | Iterable<KernelEvent>
  | AsyncIterable<KernelEvent>
  | KernelEventSubscriptionSource;

export interface OtelResource {
  readonly serviceName: string;
  readonly attributes: Record<string, Jsonish>;
}

export interface OtelLogRecord {
  readonly timestamp: number;
  readonly severityText: LogSeverity;
  readonly body: string;
  readonly attributes: Record<string, Jsonish>;
  readonly resource: OtelResource;
}

export interface OtelSpanEvent {
  readonly timestamp: number;
  readonly name: string;
  readonly attributes: Record<string, Jsonish>;
}

export interface OtelSpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly status: "unset" | "ok" | "error";
  readonly startTime: number;
  readonly endTime?: number;
  readonly durationMs?: number;
  readonly attributes: Record<string, Jsonish>;
  readonly events: readonly OtelSpanEvent[];
  readonly resource: OtelResource;
}

export interface LoggingOtelSnapshot {
  readonly logs: readonly OtelLogRecord[];
  readonly spans: readonly OtelSpanRecord[];
  readonly openSpans: readonly OtelSpanRecord[];
  readonly resource: OtelResource;
}

export interface RecordedEvent {
  readonly log: OtelLogRecord;
  readonly span?: OtelSpanRecord;
}

export interface LoggingOtelSubscription {
  readonly done: Promise<void>;
  readonly cleanup: Promise<void>;
  stop(): void;
}

export interface LoggingOtelOptions {
  readonly serviceName?: string;
  readonly resource?: Record<string, unknown>;
  readonly clock?: () => number;
  readonly logSink?: (record: OtelLogRecord) => void;
  readonly spanSink?: (record: OtelSpanRecord) => void;
  readonly maxBufferedRecords?: number;
}

export interface LoggingOtelPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly serviceName: string;
  readonly resource: OtelResource;
  record(event: KernelEvent): RecordedEvent;
  instrument(source: KernelEventSource): LoggingOtelSubscription;
  snapshot(): LoggingOtelSnapshot;
  clear(): void;
}

type LifecyclePhase = "started" | "completed" | "failed" | "cancelled";

interface MutableSpan {
  traceId: string;
  spanId: string;
  name: string;
  status: "unset" | "ok" | "error";
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: Record<string, Jsonish>;
  events: OtelSpanEvent[];
  resource: OtelResource;
}

interface NormalizedEvent {
  readonly timestamp: number;
  readonly type: string;
  readonly phase?: LifecyclePhase;
  readonly severity: LogSeverity;
  readonly body: string;
  readonly key: string;
  readonly spanName: string;
  readonly durationMs?: number;
  readonly hasError: boolean;
  readonly attributes: Record<string, Jsonish>;
}

const RESERVED_KEYS = new Set([
  "type",
  "timestamp",
  "message",
  "body",
  "summary",
  "title",
  "description",
  "level",
  "status",
  "sessionId",
  "runId",
  "delegationId",
  "durationMs",
  "attributes",
  "error",
]);

export function createLoggingOtelPlugin(
  options: LoggingOtelOptions = {},
): LoggingOtelPlugin {
  return new LoggingOtelCollector(options);
}

class LoggingOtelCollector implements LoggingOtelPlugin {
  readonly name = name;
  readonly kind = kind;
  readonly serviceName: string;
  readonly resource: OtelResource;

  #clock: () => number;
  #logSink?: (record: OtelLogRecord) => void;
  #spanSink?: (record: OtelSpanRecord) => void;
  #maxBufferedRecords: number;
  #logs: OtelLogRecord[] = [];
  #spans: OtelSpanRecord[] = [];
  #openSpans = new Map<string, MutableSpan>();
  #traceSequence = 0;
  #spanSequence = 0;

  constructor(options: LoggingOtelOptions = {}) {
    this.serviceName = normalizeString(options.serviceName, name);
    this.resource = {
      serviceName: this.serviceName,
      attributes: {
        "service.name": this.serviceName,
        "generic-ai.plugin": name,
        ...sanitizeRecord(options.resource ?? {}),
      },
    };
    this.#clock = options.clock ?? Date.now;
    this.#maxBufferedRecords = normalizeBufferedRecordLimit(
      options.maxBufferedRecords,
    );
    if (options.logSink) {
      this.#logSink = options.logSink;
    }
    if (options.spanSink) {
      this.#spanSink = options.spanSink;
    }
  }

  record(event: KernelEvent): RecordedEvent {
    const normalized = normalizeEvent(event, this.#clock);
    const log = createLogRecord(normalized, this.resource);
    appendBufferedRecord(this.#logs, log, this.#maxBufferedRecords);
    this.#logSink?.(cloneLogRecord(log));

    const span = this.#recordSpan(normalized);
    const output: RecordedEvent = span ? { log, span } : { log };
    return output;
  }

  instrument(source: KernelEventSource): LoggingOtelSubscription {
    if (isSubscriptionSource(source)) {
      let resolveDone!: () => void;
      let stopped = false;
      let doneResolved = false;
      const done = new Promise<void>((resolve) => {
        resolveDone = () => {
          if (doneResolved) {
            return;
          }

          doneResolved = true;
          resolve();
        };
      });
      const unsubscribe = source.subscribe((event) => {
        this.record(event);
      });

      return {
        done,
        cleanup: done,
        stop: () => {
          if (stopped) {
            return;
          }

          stopped = true;
          unsubscribe();
          resolveDone();
        },
      };
    }

    let resolveDone!: () => void;
    let resolveCleanup!: () => void;
    let stopped = false;
    let doneResolved = false;
    const done = new Promise<void>((resolve) => {
      resolveDone = () => {
        if (doneResolved) {
          return;
        }

        doneResolved = true;
        resolve();
      };
    });
    let cleanupResolved = false;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = () => {
        if (cleanupResolved) {
          return;
        }

        cleanupResolved = true;
        resolve();
      };
    });
    const iterator = asAsyncIterable(source)[Symbol.asyncIterator]();
    let iteratorClosed = false;
    const closeIterator = async (): Promise<void> => {
      if (iteratorClosed) {
        return;
      }

      iteratorClosed = true;
      if (typeof iterator.return === "function") {
        try {
          await iterator.return();
        } catch {
          return;
        }
      }
    };

    void (async () => {
      try {
        while (!stopped) {
          const next = await iterator.next();
          if (stopped || next.done) {
            break;
          }

          this.record(next.value);
        }
      } finally {
        stopped = true;
        await closeIterator();
        resolveCleanup();
        resolveDone();
      }
    })();

    return {
      done,
      cleanup,
      stop: () => {
        if (stopped) {
          return;
        }

        stopped = true;
        resolveDone();
        void closeIterator();
      },
    };
  }

  snapshot(): LoggingOtelSnapshot {
    return {
      logs: this.#logs.map((record) => cloneLogRecord(record)),
      spans: this.#spans.map((record) => cloneSpanRecord(record)),
      openSpans: [...this.#openSpans.values()].map((record) =>
        cloneSpanRecord(record)
      ),
      resource: cloneResource(this.resource),
    };
  }

  clear(): void {
    this.#logs = [];
    this.#spans = [];
    this.#openSpans.clear();
  }

  #recordSpan(event: NormalizedEvent): OtelSpanRecord | undefined {
    if (!event.phase) {
      return undefined;
    }

    if (event.phase === "started") {
      const span = createMutableSpan(event, this.resource, this.#nextTraceId(), this.#nextSpanId());
      this.#openSpans.set(event.key, span);
      return undefined;
    }

    const existing = this.#openSpans.get(event.key);
    const span = existing
      ? finalizeMutableSpan(existing, event)
      : finalizeMutableSpan(
          createMutableSpan(event, this.resource, this.#nextTraceId(), this.#nextSpanId()),
          event,
        );

    this.#openSpans.delete(event.key);
    const frozen = cloneSpanRecord(span);
    appendBufferedRecord(this.#spans, frozen, this.#maxBufferedRecords);
    this.#spanSink?.(cloneSpanRecord(frozen));
    return frozen;
  }

  #nextTraceId(): string {
    this.#traceSequence += 1;
    return `trace-${this.#traceSequence}`;
  }

  #nextSpanId(): string {
    this.#spanSequence += 1;
    return `span-${this.#spanSequence}`;
  }
}

function normalizeEvent(
  event: KernelEvent,
  clock: () => number,
): NormalizedEvent {
  const type = normalizeString(event.type, "event");
  const phase = resolvePhase(type, event.status);
  const severity = resolveSeverity(event.level, phase, event.error !== undefined);
  const body =
    normalizeOptionalString(event.message) ??
    normalizeOptionalString(event.body) ??
    normalizeOptionalString(event.summary) ??
    normalizeOptionalString(event.title) ??
    normalizeOptionalString(event.description) ??
    type;
  const key =
    normalizeOptionalString(event.sessionId) ??
    normalizeOptionalString(event.runId) ??
    normalizeOptionalString(event.delegationId) ??
    type;
  const scope = type.split(".", 2)[0] ?? type;

  const normalized: NormalizedEvent = {
    timestamp: normalizeTimestamp(event.timestamp, clock),
    type,
    ...(phase ? { phase } : {}),
    severity,
    body,
    key,
    spanName: normalizeString(scope, type),
    ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
      ? { durationMs: event.durationMs }
      : {}),
    hasError: event.error !== undefined,
    attributes: buildAttributes(event, phase),
  };

  return normalized;
}

function normalizeBufferedRecordLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 1_000;
  }

  if (limit === Number.POSITIVE_INFINITY) {
    return limit;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(
      "Logging OTEL buffers require a positive integer `maxBufferedRecords` value.",
    );
  }

  return limit;
}

function appendBufferedRecord<T>(
  buffer: T[],
  record: T,
  maxBufferedRecords: number,
): void {
  buffer.push(record);
  if (!Number.isFinite(maxBufferedRecords) || buffer.length <= maxBufferedRecords) {
    return;
  }

  buffer.splice(0, buffer.length - maxBufferedRecords);
}

function createLogRecord(
  event: NormalizedEvent,
  resource: OtelResource,
): OtelLogRecord {
  return {
    timestamp: event.timestamp,
    severityText: event.severity,
    body: event.body,
    attributes: sanitizeRecord(event.attributes),
    resource: cloneResource(resource),
  };
}

function createMutableSpan(
  event: NormalizedEvent,
  resource: OtelResource,
  traceId: string,
  spanId: string,
): MutableSpan {
  const span: MutableSpan = {
    traceId,
    spanId,
    name: event.spanName,
    status: "unset",
    startTime: event.phase === "started"
      ? event.timestamp
      : event.timestamp - (event.durationMs ?? 0),
    attributes: sanitizeRecord(event.attributes),
    events: [createSpanEvent(event)],
    resource: cloneResource(resource),
  };

  return span;
}

function finalizeMutableSpan(
  span: MutableSpan,
  event: NormalizedEvent,
): MutableSpan {
  span.events.push(createSpanEvent(event));
  span.endTime = event.timestamp;
  span.durationMs = event.durationMs ?? Math.max(0, event.timestamp - span.startTime);
  span.status = event.phase === "failed" || event.phase === "cancelled" || event.hasError
    ? "error"
    : "ok";
  span.attributes = {
    ...span.attributes,
    ...sanitizeRecord(event.attributes),
  };
  return span;
}

function createSpanEvent(event: NormalizedEvent): OtelSpanEvent {
  return {
    timestamp: event.timestamp,
    name: event.type,
    attributes: sanitizeRecord({
      ...event.attributes,
      ...(event.phase ? { phase: event.phase } : {}),
    }),
  };
}

function resolvePhase(
  type: string,
  status: string | undefined,
): LifecyclePhase | undefined {
  const match = type.match(/(?:^|\.)((?:started|completed|failed|cancelled))$/i);
  if (match?.[1]) {
    return match[1].toLowerCase() as LifecyclePhase;
  }

  const normalizedStatus = normalizeOptionalString(status);
  if (
    normalizedStatus === "started" ||
    normalizedStatus === "completed" ||
    normalizedStatus === "failed" ||
    normalizedStatus === "cancelled"
  ) {
    return normalizedStatus;
  }

  return undefined;
}

function resolveSeverity(
  level: string | undefined,
  phase: LifecyclePhase | undefined,
  hasError: boolean,
): LogSeverity {
  const normalized = normalizeOptionalString(level);
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }

  if (phase === "failed" || hasError) {
    return "error";
  }

  if (phase === "cancelled") {
    return "warn";
  }

  return "info";
}

function normalizeTimestamp(
  value: number | Date | undefined,
  clock: () => number,
): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return clock();
}

function normalizeString(value: unknown, fallback: string): string {
  return normalizeOptionalString(value) ?? fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function buildAttributes(
  event: KernelEvent,
  phase: LifecyclePhase | undefined,
): Record<string, Jsonish> {
  const attributes: Record<string, Jsonish> = {};

  for (const [key, value] of Object.entries(event)) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }

    attributes[key] = sanitizeValue(value);
  }

  if (event.attributes) {
    for (const [key, value] of Object.entries(event.attributes)) {
      attributes[key] = sanitizeValue(value);
    }
  }

  attributes["eventType"] = event.type;
  if (phase) {
    attributes["phase"] = phase;
  }

  return attributes;
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, Jsonish> {
  const sanitized: Record<string, Jsonish> = {};
  for (const [key, value] of Object.entries(record)) {
    sanitized[key] = sanitizeValue(value);
  }

  return sanitized;
}

function sanitizeValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): Jsonish {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined") {
    return null;
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const sanitized: Record<string, Jsonish> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = sanitizeValue(entry, seen);
    }
    return sanitized;
  }

  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function cloneResource(resource: OtelResource): OtelResource {
  return {
    serviceName: resource.serviceName,
    attributes: sanitizeRecord(resource.attributes),
  };
}

function cloneLogRecord(record: OtelLogRecord): OtelLogRecord {
  return {
    timestamp: record.timestamp,
    severityText: record.severityText,
    body: record.body,
    attributes: sanitizeRecord(record.attributes),
    resource: cloneResource(record.resource),
  };
}

function cloneSpanRecord(record: MutableSpan | OtelSpanRecord): OtelSpanRecord {
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    name: record.name,
    status: record.status,
    startTime: record.startTime,
    ...(record.endTime === undefined ? {} : { endTime: record.endTime }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    attributes: sanitizeRecord(record.attributes),
    events: record.events.map((event) => ({
      timestamp: event.timestamp,
      name: event.name,
      attributes: sanitizeRecord(event.attributes),
    })),
    resource: cloneResource(record.resource),
  };
}

function isSubscriptionSource(
  value: KernelEventSource,
): value is KernelEventSubscriptionSource {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (
    Symbol.iterator in value ||
    Symbol.asyncIterator in value
  ) {
    return false;
  }

  return "subscribe" in value && typeof value.subscribe === "function";
}

async function* asAsyncIterable(
  source: Iterable<KernelEvent> | AsyncIterable<KernelEvent>,
): AsyncIterable<KernelEvent> {
  if (Symbol.asyncIterator in source) {
    for await (const item of source) {
      yield item;
    }
    return;
  }

  for (const item of source) {
    yield item;
  }
}
