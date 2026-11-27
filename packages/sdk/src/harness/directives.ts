import type { JsonObject } from "../contracts/shared.js";

/** A pass or fail an agent can state at the end of its output. */
export type ActorVerdict = "pass" | "fail";

export interface ParsedActorDirectives {
  readonly verdict?: ActorVerdict;
  readonly data?: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract machine-readable directives from an actor's text output.
 *
 * Recognised forms:
 * - a `VERDICT: PASS` / `VERDICT: FAIL` line (the last one wins), and
 * - the last fenced ```json block whose body is a JSON object. Its `verdict`
 *   field, when present, overrides the line form.
 */
export function parseActorDirectives(outputText: string | undefined): ParsedActorDirectives {
  if (outputText === undefined || outputText.length === 0) {
    return {};
  }

  let verdict: ActorVerdict | undefined;
  for (const match of outputText.matchAll(/^\s*\**\s*VERDICT\s*\**\s*:\s*\**\s*(PASS|FAIL)\b/gim)) {
    verdict = match[1]?.toUpperCase() === "PASS" ? "pass" : "fail";
  }

  let data: JsonObject | undefined;
  for (const match of outputText.matchAll(/```json\s*\n([\s\S]*?)```/gi)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      if (isJsonObject(parsed)) {
        data = parsed;
      }
    } catch {
      // Ignore malformed blocks; an earlier valid block still counts.
    }
  }

  const dataVerdict = data?.["verdict"];
  if (typeof dataVerdict === "string") {
    const normalized = dataVerdict.trim().toLowerCase();
    if (normalized === "pass" || normalized === "fail") {
      verdict = normalized;
    }
  }

  return {
    ...(verdict === undefined ? {} : { verdict }),
    ...(data === undefined ? {} : { data }),
  };
}
