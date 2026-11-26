import { secretRedactionMarker } from "@generic-ai/sdk";

/** Values shorter than this are never redacted: they would mangle ordinary text. */
export const MIN_REDACT_LENGTH = 4;
/** Encoded forms (base64, URL, JSON-escaped) are only added for values at least this long. */
export const MIN_ENCODED_REDACT_LENGTH = 8;

interface Needle {
  readonly text: string;
  readonly marker: string;
}

/**
 * Replaces known secret values (and their common encodings) with `[REDACTED:NAME]`.
 *
 * The redactor only grows: a rotated or deleted secret's old value keeps being scrubbed for the
 * life of the process, because it may still sit in a transcript, a log line or a tool result.
 */
export class SecretRedactor {
  readonly #values = new Map<string, Set<string>>();
  #needles: readonly Needle[] = [];
  #weak = new Set<string>();

  /** Register a value. Returns false when it is too short to redact safely. */
  add(name: string, value: string): boolean {
    if (value.length < MIN_REDACT_LENGTH) {
      this.#weak.add(name);
      return false;
    }
    let values = this.#values.get(name);
    if (values === undefined) {
      values = new Set();
      this.#values.set(name, values);
    }
    if (values.has(value)) {
      return true;
    }
    values.add(value);
    this.#rebuild();
    return true;
  }

  /** Names whose value is too short to redact. Hosts should warn about these. */
  weakNames(): readonly string[] {
    return [...this.#weak];
  }

  get size(): number {
    return this.#needles.length;
  }

  redactText(text: string): string {
    if (this.#needles.length === 0 || text.length < MIN_REDACT_LENGTH) {
      return text;
    }
    let result = text;
    for (const needle of this.#needles) {
      if (result.includes(needle.text)) {
        result = result.split(needle.text).join(needle.marker);
      }
    }
    return result;
  }

  /** Deep copy with every string scrubbed. Plain objects and arrays are walked; other objects pass through. */
  redact<TValue>(value: TValue): TValue {
    if (this.#needles.length === 0) {
      return value;
    }
    return this.#walk(value, new WeakMap()) as TValue;
  }

  #walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === "string") {
      return this.redactText(value);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const cached = seen.get(value);
    if (cached !== undefined) {
      return cached;
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const item of value) {
        copy.push(this.#walk(item, seen));
      }
      return Object.isFrozen(value) ? Object.freeze(copy) : copy;
    }
    if (value instanceof Error) {
      const message = this.redactText(value.message);
      if (message === value.message) {
        return value;
      }
      const copy = new Error(message);
      copy.name = value.name;
      seen.set(value, copy);
      return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) {
      copy[key] = this.#walk(item, seen);
    }
    return Object.isFrozen(value) ? Object.freeze(copy) : copy;
  }

  #rebuild(): void {
    const byText = new Map<string, string>();
    for (const [name, values] of this.#values) {
      const marker = secretRedactionMarker(name);
      for (const value of values) {
        for (const variant of variantsOf(value)) {
          // First registration wins when two secrets share a value.
          if (!byText.has(variant)) {
            byText.set(variant, marker);
          }
        }
      }
    }
    // Longest first, so a value that contains another value is replaced whole.
    this.#needles = Object.freeze(
      [...byText.entries()]
        .map(([text, marker]) => ({ text, marker }))
        .sort((left, right) => right.text.length - left.text.length),
    );
  }
}

function variantsOf(value: string): readonly string[] {
  const variants = new Set<string>([value]);
  const trimmed = value.trim();
  if (trimmed.length >= MIN_REDACT_LENGTH) {
    variants.add(trimmed);
  }
  if (value.length >= MIN_ENCODED_REDACT_LENGTH) {
    const bytes = Buffer.from(value, "utf8");
    const base64 = bytes.toString("base64");
    variants.add(base64);
    variants.add(base64.replace(/=+$/, ""));
    variants.add(bytes.toString("base64url"));
    variants.add(encodeURIComponent(value));
    variants.add(JSON.stringify(value).slice(1, -1));
  }
  return [...variants].filter((variant) => variant.length >= MIN_REDACT_LENGTH);
}
