// Schedule expressions and heartbeat commands. Adapted from Prime Agent's cron module
// (`crates/pa-core/src/cron/mod.rs`, PrimeIntellect-ai/prime-agent): one-shot `in 10m` and
// `at <ISO date>`, recurring `every 5m`, five-field cron expressions in UTC with the @hourly,
// @daily, @weekly and @monthly aliases, and the `/heartbeat` command grammar.
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

export type ScheduleKind = "once" | "cron" | "interval";

export interface Schedule {
  readonly kind: ScheduleKind;
  /** The expression as given (an alias is stored as its five cron fields). */
  readonly expression: string;
  readonly intervalMs?: number;
}

export interface ParsedSchedule {
  readonly schedule: Schedule;
  /** The first run, in epoch milliseconds. */
  readonly nextRunAt: number;
}

/** How a heartbeat reaches a session that is mid-turn. */
export type DeliveryMode = "steer" | "follow_up";

export const DEFAULT_HEARTBEAT_SCHEDULE = "every 5m";
export const DEFAULT_HEARTBEAT_DELIVERY_MODE: DeliveryMode = "steer";
export const MIN_INTERVAL_MS = 10_000;

const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;
const ONE_DAY_MS = 24 * 60 * ONE_MINUTE_MS;
const HEARTBEAT_USAGE =
  "Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>";
const DELIVERY_MODE_ERROR = 'Heartbeat delivery mode must be "steer" or "follow_up"';
const CRON_USAGE =
  "Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday";

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function unitMultiplier(unit: string, allowSeconds: boolean): number | undefined {
  const value = unit.trim();
  if (allowSeconds && ["s", "sec", "secs", "second", "seconds"].includes(value)) {
    return ONE_SECOND_MS;
  }
  if (["m", "min", "mins", "minute", "minutes"].includes(value)) {
    return ONE_MINUTE_MS;
  }
  if (["h", "hr", "hrs", "hour", "hours"].includes(value)) {
    return 60 * ONE_MINUTE_MS;
  }
  if (["d", "day", "days"].includes(value)) {
    return ONE_DAY_MS;
  }
  return undefined;
}

/** `<digits> <unit?>` with the unit attached or separated by spaces (`10m`, `10 m`). */
function splitAmountUnit(rest: string): { amount: number; unit: string } | undefined {
  const text = rest.trim();
  const digits = /^\d+/.exec(text)?.[0];
  if (digits === undefined) {
    return undefined;
  }
  const after = text.slice(digits.length);
  const unit = after.trim();
  if (unit.length > 0 && !/^\s/.test(after) && !/^[a-zA-Z]+$/.test(unit)) {
    return undefined;
  }
  return { amount: Number(digits), unit };
}

/** Epoch milliseconds for an ISO-8601 date-time (`T` required), or undefined. */
export function parseIsoMillis(text: string): number | undefined {
  const value = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}(:\d{2}){0,2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(value)) {
    return undefined;
  }
  const withZone = /(Z|[+-]\d{2}(:?\d{2})?)$/.test(value) ? value : `${value}Z`;
  const millis = Date.parse(withZone);
  return Number.isNaN(millis) ? undefined : millis;
}

/** Parses a schedule expression into a schedule and its first run after `now`. */
export function parseSchedule(input: string, now: number): ParsedSchedule {
  const text = stripMatchingQuotes(input.trim());
  if (text.length === 0) {
    throw new Error("Cron schedule cannot be empty");
  }
  const lower = text.toLowerCase();
  if (lower.startsWith("in ")) {
    const parsed = splitAmountUnit(lower.slice(3));
    const multiplier = parsed === undefined ? undefined : unitMultiplier(parsed.unit, false);
    if (parsed !== undefined && multiplier !== undefined) {
      return {
        schedule: { kind: "once", expression: text },
        nextRunAt: now + parsed.amount * multiplier,
      };
    }
  }
  for (const prefix of ["every ", "each "]) {
    if (lower.startsWith(prefix)) {
      const parsed = splitAmountUnit(lower.slice(prefix.length));
      const multiplier = parsed === undefined ? undefined : unitMultiplier(parsed.unit, true);
      if (parsed !== undefined && multiplier !== undefined) {
        const intervalMs = parsed.amount * multiplier;
        if (intervalMs < MIN_INTERVAL_MS) {
          throw new Error("Recurring interval must be at least 10 seconds");
        }
        return {
          schedule: { kind: "interval", expression: text, intervalMs },
          nextRunAt: now + intervalMs,
        };
      }
    }
  }
  if (lower.startsWith("at ")) {
    const when = parseIsoMillis(text.slice(3));
    if (when === undefined) {
      throw new Error("Invalid one-shot schedule. Use: at <ISO date>");
    }
    if (when <= now) {
      throw new Error("One-shot schedule must be in the future");
    }
    return { schedule: { kind: "once", expression: text }, nextRunAt: when };
  }
  const expression = normalizeCronAlias(text);
  return { schedule: { kind: "cron", expression }, nextRunAt: nextCronRunAfter(expression, now) };
}

/** The next run strictly after `after`, or undefined for a one-shot schedule. */
export function nextRunAfter(schedule: Schedule, after: number): number | undefined {
  switch (schedule.kind) {
    case "once":
      return undefined;
    case "interval":
      if (schedule.intervalMs === undefined || schedule.intervalMs <= 0) {
        throw new Error(`Invalid interval schedule: ${schedule.expression}`);
      }
      return after + schedule.intervalMs;
    case "cron":
      return nextCronRunAfter(schedule.expression, after);
  }
}

function normalizeCronAlias(text: string): string {
  switch (text) {
    case "@hourly":
      return "0 * * * *";
    case "@daily":
      return "0 0 * * *";
    case "@weekly":
      return "0 0 * * 0";
    case "@monthly":
      return "0 0 1 * *";
    default:
      return text;
  }
}

interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
}

function parseCronNumber(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid cron number: ${value}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new Error(`Cron number out of range: ${value}`);
  }
  return parsed;
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part.length === 0) {
      throw new Error(`Invalid cron field: ${field}`);
    }
    const slash = part.indexOf("/");
    const rangeText = slash === -1 ? part : part.slice(0, slash);
    const step = slash === -1 ? 1 : parseCronNumber(part.slice(slash + 1), 1, max);
    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = min;
      end = max;
    } else if (rangeText.includes("-")) {
      const [startText = "", endText = ""] = rangeText.split("-", 2);
      start = parseCronNumber(startText, min, max);
      end = parseCronNumber(endText, min, max);
      if (start > end) {
        throw new Error(`Invalid cron range: ${rangeText}`);
      }
    } else {
      start = parseCronNumber(rangeText, min, max);
      end = start;
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

function parseCronExpression(expression: string): CronFields {
  const parts = expression.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length !== 5) {
    throw new Error(CRON_USAGE);
  }
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = parts;
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(day, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(weekday, 0, 7),
  };
}

function dayMatches(date: Date, fields: CronFields): boolean {
  const weekday = date.getUTCDay();
  return (
    fields.dayOfMonth.has(date.getUTCDate()) &&
    fields.month.has(date.getUTCMonth() + 1) &&
    (fields.dayOfWeek.has(weekday) || (weekday === 0 && fields.dayOfWeek.has(7)))
  );
}

/** True when a timestamp falls on a minute the cron expression matches (UTC). */
export function cronMatches(expression: string, timestamp: number): boolean {
  const fields = parseCronExpression(expression);
  const date = new Date(timestamp);
  return (
    fields.minute.has(date.getUTCMinutes()) &&
    fields.hour.has(date.getUTCHours()) &&
    dayMatches(date, fields)
  );
}

/**
 * The first whole minute after `after` that the expression matches, within a year. Days and hours
 * that cannot match are skipped whole, which gives the same answer as a minute-by-minute scan.
 */
function nextCronRunAfter(expression: string, after: number): number {
  const fields = parseCronExpression(expression);
  let candidate = (Math.floor(after / ONE_MINUTE_MS) + 1) * ONE_MINUTE_MS;
  const deadline = candidate + 366 * ONE_DAY_MS;
  while (candidate <= deadline) {
    const date = new Date(candidate);
    if (!dayMatches(date, fields)) {
      candidate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      continue;
    }
    if (!fields.hour.has(date.getUTCHours())) {
      candidate = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours() + 1,
      );
      continue;
    }
    if (fields.minute.has(date.getUTCMinutes())) {
      return candidate;
    }
    candidate += ONE_MINUTE_MS;
  }
  throw new Error(`Cron schedule did not match within one year: ${expression}`);
}

/** `5m` becomes `every 5m`; an empty schedule becomes the default `every 5m`. */
export function normalizeHeartbeatSchedule(input?: string): string {
  const text = input?.trim();
  if (text === undefined || text.length === 0) {
    return DEFAULT_HEARTBEAT_SCHEDULE;
  }
  const parsed = splitAmountUnit(text);
  if (
    parsed !== undefined &&
    parsed.unit.length > 0 &&
    unitMultiplier(parsed.unit, true) !== undefined
  ) {
    return `every ${text}`;
  }
  return text;
}

export function normalizeDeliveryMode(value: string | undefined): DeliveryMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.toLowerCase().replaceAll("-", "_");
  if (normalized === "steer" || normalized === "follow_up") {
    return normalized;
  }
  throw new Error(DELIVERY_MODE_ERROR);
}

export type HeartbeatCommand =
  | { readonly kind: "status" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "clear" }
  | {
      readonly kind: "set";
      readonly schedule: string;
      readonly instruction: string;
      readonly deliveryMode?: DeliveryMode;
    };

function splitFirstToken(value: string): [string, string] {
  const index = value.search(/\s/);
  return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index).trimStart()];
}

function consumeLeadingDeliveryFlag(text: string): [DeliveryMode, string] | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("--")) {
    return undefined;
  }
  const afterDash = trimmed.slice(2);
  if (afterDash.startsWith("deliver")) {
    const rest = afterDash.slice("deliver".length);
    const value = rest.startsWith("=") ? rest.slice(1) : /^\s/.test(rest) ? rest.slice(1) : "";
    if (value.length === 0) {
      throw new Error(DELIVERY_MODE_ERROR);
    }
    const [token, remainder] = splitFirstToken(value);
    return [normalizeDeliveryMode(token) as DeliveryMode, remainder];
  }
  for (const [token, mode] of [
    ["steer", "steer"],
    ["follow-up", "follow_up"],
    ["follow_up", "follow_up"],
  ] as const) {
    if (afterDash.startsWith(token)) {
      const after = afterDash.slice(token.length);
      if (after.length > 0 && !/^\s/.test(after)) {
        throw new Error(DELIVERY_MODE_ERROR);
      }
      return [mode, after];
    }
  }
  return undefined;
}

function consumeTrailingDeliveryFlag(text: string): [DeliveryMode, string] | undefined {
  const lower = text.toLowerCase();
  for (const marker of [" --deliver ", " --deliver="]) {
    const index = lower.lastIndexOf(marker);
    if (index !== -1) {
      const token = text.slice(index + marker.length).trim();
      if (token.length > 0 && !/\s/.test(token)) {
        return [normalizeDeliveryMode(token) as DeliveryMode, text.slice(0, index)];
      }
    }
  }
  for (const token of ["--follow-up", "--follow_up", "--steer"]) {
    const index = lower.lastIndexOf(` ${token}`);
    if (index !== -1 && index + token.length + 1 === text.length) {
      return [normalizeDeliveryMode(token.slice(2)) as DeliveryMode, text.slice(0, index)];
    }
  }
  return undefined;
}

function consumeDeliveryOption(text: string): [DeliveryMode | undefined, string] {
  let rest = text.trim();
  const lower = rest.toLowerCase();
  if (lower === "--deliver" || lower.endsWith(" --deliver")) {
    throw new Error(DELIVERY_MODE_ERROR);
  }
  let leading: DeliveryMode | undefined;
  for (
    let flag = consumeLeadingDeliveryFlag(rest);
    flag !== undefined;
    flag = consumeLeadingDeliveryFlag(rest)
  ) {
    leading = flag[0];
    rest = flag[1].trim();
  }
  let trailing: DeliveryMode | undefined;
  for (
    let flag = consumeTrailingDeliveryFlag(rest);
    flag !== undefined;
    flag = consumeTrailingDeliveryFlag(rest)
  ) {
    // Every trailing flag is consumed; the rightmost one wins.
    trailing ??= flag[0];
    rest = flag[1].trim();
  }
  return [trailing ?? leading, rest];
}

function consumeEveryOption(text: string): [string, string] | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("--every")) {
    return undefined;
  }
  let rest = trimmed.slice("--every".length);
  if (rest.startsWith("=")) {
    rest = rest.slice(1);
  } else if (/^\s/.test(rest)) {
    rest = rest.slice(1);
  } else if (rest.length > 0) {
    return undefined;
  }
  let interval: string;
  let remainder: string;
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const close = rest.indexOf(quote, 1);
    interval = close === -1 ? rest.slice(1) : rest.slice(1, close);
    remainder = close === -1 ? "" : rest.slice(close + 1);
  } else {
    [interval, remainder] = splitFirstToken(rest);
  }
  if (interval.length === 0) {
    throw new Error(HEARTBEAT_USAGE);
  }
  return [interval, remainder.trimStart()];
}

function consumeLeadingEverySchedule(text: string): [string, string] | undefined {
  const lower = text.toLowerCase();
  for (const prefix of ["every ", "each "]) {
    if (!lower.startsWith(prefix)) {
      continue;
    }
    const firstToken = lower
      .slice(prefix.length)
      .split(/\s+/)
      .find((token) => token.length > 0);
    if (firstToken === undefined) {
      return undefined;
    }
    const parsed = splitAmountUnit(firstToken);
    if (
      parsed === undefined ||
      parsed.unit.length === 0 ||
      unitMultiplier(parsed.unit, true) === undefined
    ) {
      continue;
    }
    const consumed = Math.min(
      text.length,
      text.indexOf(firstToken, prefix.length) + firstToken.length,
    );
    let remainder = text.slice(consumed).trim();
    // A standalone "--" separator is dropped, never a flag.
    if (remainder === "--" || /^--\s/.test(remainder)) {
      remainder = remainder.slice(2).trim();
    }
    return [`${prefix.trim()} ${firstToken}`, remainder];
  }
  return undefined;
}

/** Parses a `/heartbeat ...` command (the leading `/heartbeat` is optional). */
export function parseHeartbeatCommand(input: string): HeartbeatCommand {
  const text =
    input.startsWith("/heartbeat") && (input.length === 10 || /^\s/.test(input.slice(10)))
      ? input.slice(10).trim()
      : input.trim();
  if (text.length === 0 || text === "status") {
    return { kind: "status" };
  }
  if (text === "pause" || text === "resume") {
    return { kind: text };
  }
  if (text === "clear" || text === "stop") {
    return { kind: "clear" };
  }
  const [leadingMode, rest] = consumeDeliveryOption(text);
  const scheduled = consumeEveryOption(rest) ?? consumeLeadingEverySchedule(rest);
  if (scheduled !== undefined) {
    const [trailingMode, instruction] = consumeDeliveryOption(scheduled[1]);
    if (instruction.length === 0) {
      throw new Error(HEARTBEAT_USAGE);
    }
    const deliveryMode = trailingMode ?? leadingMode;
    return {
      kind: "set",
      schedule: normalizeHeartbeatSchedule(scheduled[0]),
      instruction,
      ...(deliveryMode === undefined ? {} : { deliveryMode }),
    };
  }
  const instruction = rest.trim();
  if (instruction.length === 0) {
    throw new Error(HEARTBEAT_USAGE);
  }
  return {
    kind: "set",
    schedule: DEFAULT_HEARTBEAT_SCHEDULE,
    instruction,
    ...(leadingMode === undefined ? {} : { deliveryMode: leadingMode }),
  };
}
