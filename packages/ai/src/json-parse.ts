import type { JsonObject, ToolCall } from "./types.js";

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Repair the JSON mistakes models commonly make inside strings: invalid escapes (`\u` without four
 * hex digits, `\q`) become literal backslashes, and raw control characters are escaped. Text
 * outside strings is left unchanged.
 */
export function repairJson(json: string): string {
  let output = "";
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index] as string;
    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      output += char;
      continue;
    }
    if (char === '"') {
      inString = false;
      output += char;
      continue;
    }
    if (char === "\\") {
      const next = json[index + 1];
      if (next === undefined) {
        output += "\\\\";
        continue;
      }
      if (next === "u") {
        const hex = json.slice(index + 2, index + 6);
        if (HEX4.test(hex)) {
          output += `\\u${hex}`;
          index += 5;
        } else if (index + 2 + hex.length >= json.length && /^[0-9a-fA-F]*$/.test(hex)) {
          // A cut-off escape at the end of the text: keep it for the caller to treat as incomplete.
          output += `\\u${hex}`;
          index += 1 + hex.length;
        } else {
          output += "\\\\";
        }
        continue;
      }
      if (next in SIMPLE_ESCAPES) {
        output += `\\${next}`;
        index += 1;
        continue;
      }
      output += "\\\\";
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20) {
      output +=
        char === "\n"
          ? "\\n"
          : char === "\r"
            ? "\\r"
            : char === "\t"
              ? "\\t"
              : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    output += char;
  }
  return output;
}

/** `JSON.parse` that first tries the text as-is and then with {@link repairJson} applied. */
export function parseJsonWithRepair<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const repaired = repairJson(json);
    if (repaired === json) {
      throw error;
    }
    return JSON.parse(repaired) as T;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the complete arguments text of a tool call. Never throws: invalid or non-object JSON yields
 * empty arguments and an `argumentsError` that quotes the received text, so validation can report it
 * to the model. Cut-off JSON is not completed.
 */
export function parseToolCallArguments(
  json: string | undefined,
): Pick<ToolCall, "arguments"> & { argumentsError?: string } {
  if (json === undefined || json.trim() === "") {
    return { arguments: {} };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepair<unknown>(json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      arguments: {},
      argumentsError: `Tool arguments are not valid JSON: ${reason}\n\nReceived arguments:\n${json}`,
    };
  }
  if (!isJsonObject(parsed)) {
    return {
      arguments: {},
      argumentsError: `Tool arguments must be a JSON object\n\nReceived arguments:\n${json}`,
    };
  }
  return { arguments: parsed };
}

interface Parsed {
  readonly value: unknown;
  readonly complete: boolean;
  readonly end: number;
}

const INCOMPLETE: unique symbol = Symbol("incomplete");

class PartialJsonParser {
  constructor(private readonly text: string) {}

  parse(): unknown {
    const result = this.value(this.ws(0));
    return result.value === INCOMPLETE ? undefined : result.value;
  }

  private ws(index: number): number {
    let position = index;
    while (position < this.text.length && /\s/.test(this.text[position] as string)) {
      position += 1;
    }
    return position;
  }

  private value(index: number): Parsed {
    const char = this.text[index];
    if (char === undefined) {
      return { value: INCOMPLETE, complete: false, end: index };
    }
    if (char === "{") {
      return this.object(index);
    }
    if (char === "[") {
      return this.array(index);
    }
    if (char === '"') {
      return this.string(index);
    }
    return this.scalar(index);
  }

  private object(index: number): Parsed {
    const result: Record<string, unknown> = {};
    let position = this.ws(index + 1);
    while (true) {
      const char = this.text[position];
      if (char === undefined) {
        return { value: result, complete: false, end: position };
      }
      if (char === "}") {
        return { value: result, complete: true, end: position + 1 };
      }
      if (char === ",") {
        position = this.ws(position + 1);
        continue;
      }
      if (char !== '"') {
        // Malformed: keep what we have.
        return { value: result, complete: false, end: this.text.length };
      }
      const key = this.string(position);
      if (!key.complete) {
        return { value: result, complete: false, end: this.text.length };
      }
      position = this.ws(key.end);
      if (this.text[position] !== ":") {
        return { value: result, complete: false, end: this.text.length };
      }
      const item = this.value(this.ws(position + 1));
      if (item.value !== INCOMPLETE) {
        result[key.value as string] = item.value;
      }
      if (!item.complete) {
        return { value: result, complete: false, end: this.text.length };
      }
      position = this.ws(item.end);
    }
  }

  private array(index: number): Parsed {
    const result: unknown[] = [];
    let position = this.ws(index + 1);
    while (true) {
      const char = this.text[position];
      if (char === undefined) {
        return { value: result, complete: false, end: position };
      }
      if (char === "]") {
        return { value: result, complete: true, end: position + 1 };
      }
      if (char === ",") {
        position = this.ws(position + 1);
        continue;
      }
      const item = this.value(position);
      if (item.value !== INCOMPLETE) {
        result.push(item.value);
      }
      if (!item.complete) {
        return { value: result, complete: false, end: this.text.length };
      }
      position = this.ws(item.end);
    }
  }

  private string(index: number): Parsed {
    let output = "";
    let position = index + 1;
    while (position < this.text.length) {
      const char = this.text[position] as string;
      if (char === '"') {
        return { value: output, complete: true, end: position + 1 };
      }
      if (char !== "\\") {
        output += char;
        position += 1;
        continue;
      }
      const next = this.text[position + 1];
      if (next === undefined) {
        break;
      }
      if (next === "u") {
        const hex = this.text.slice(position + 2, position + 6);
        if (HEX4.test(hex)) {
          output += String.fromCharCode(Number.parseInt(hex, 16));
          position += 6;
          continue;
        }
        if (position + 2 + hex.length >= this.text.length && /^[0-9a-fA-F]*$/.test(hex)) {
          // Cut off mid-escape: drop the partial escape.
          position = this.text.length;
          break;
        }
        output += "\\u";
        position += 2;
        continue;
      }
      const simple = SIMPLE_ESCAPES[next];
      if (simple !== undefined) {
        output += simple;
      } else {
        output += `\\${next}`;
      }
      position += 2;
    }
    return { value: output, complete: false, end: this.text.length };
  }

  private scalar(index: number): Parsed {
    const rest = this.text.slice(index);
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (rest.startsWith(literal)) {
        return { value, complete: true, end: index + literal.length };
      }
      if (literal.startsWith(rest.trimEnd()) && rest.trimEnd().length > 0) {
        return { value: INCOMPLETE, complete: false, end: this.text.length };
      }
    }
    const match = /^-?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) {
      return { value: INCOMPLETE, complete: false, end: this.text.length };
    }
    const end = index + match[0].length;
    const complete = end < this.text.length;
    return { value: Number(match[0]), complete, end };
  }
}

/**
 * Best-effort parse of JSON that is still streaming in. Returns the fields that are present so far
 * (partial strings included, cut-off literals and escapes omitted). Returns `{}` when nothing usable
 * has arrived. Never throws.
 */
export function parseStreamingJson<T = Record<string, unknown>>(
  partialJson: string | undefined,
): T {
  if (partialJson === undefined || partialJson.trim() === "") {
    return {} as T;
  }
  try {
    return JSON.parse(partialJson) as T;
  } catch {
    // fall through to the tolerant parser
  }
  try {
    const value = new PartialJsonParser(partialJson).parse();
    return (value ?? {}) as T;
  } catch {
    return {} as T;
  }
}
