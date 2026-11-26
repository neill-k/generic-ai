import { createHash } from "node:crypto";
import { GoalSpecError, parseGoalSpec } from "./schema.js";
import type { GoalSpec, SealedGoal } from "./types.js";

/**
 * Sealing is how validators stay out of the agent's reach.
 *
 * - `sealGoal` validates the spec, takes a deep copy, freezes it, and records
 *   a sha256 fingerprint over its canonical JSON.
 * - Only objects created here are registered as sealed. The runner refuses
 *   look-alike objects, so a goal cannot be swapped for one an agent wrote.
 * - The runner re-hashes the spec before every run and refuses a goal whose
 *   fingerprint no longer matches.
 *
 * Hosts should keep the sealed goal (or its fingerprint) outside anything the
 * agent can write, and pass it to the runner themselves.
 */

const sealedGoals = new WeakSet<object>();

export class GoalTamperError extends Error {
  readonly goalId: string;

  constructor(goalId: string, message: string) {
    super(message);
    this.name = "GoalTamperError";
    this.goalId = goalId;
  }
}

/** JSON with object keys sorted recursively, so equal specs hash equally. */
export function canonicalGoalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        sorted[key] = sortKeys(source[key]);
      }
    }
    return sorted;
  }
  return value;
}

export function fingerprintGoalSpec(spec: GoalSpec): string {
  return createHash("sha256").update(canonicalGoalJson(spec)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Validates, copies, freezes, and fingerprints a goal. Throws `GoalSpecError`. */
export function sealGoal(input: unknown): SealedGoal {
  const parsed = parseGoalSpec(input);
  if (!parsed.ok) {
    throw new GoalSpecError(parsed.issues);
  }
  // Copy through JSON so the caller's object (which an agent might still hold
  // a reference to) can no longer reach the sealed spec.
  const spec = deepFreeze(JSON.parse(canonicalGoalJson(parsed.value)) as GoalSpec);
  const sealed: SealedGoal = Object.freeze({
    kind: "sealed-goal",
    spec,
    fingerprint: fingerprintGoalSpec(spec),
  });
  sealedGoals.add(sealed);
  return sealed;
}

export function isSealedGoal(value: unknown): value is SealedGoal {
  return typeof value === "object" && value !== null && sealedGoals.has(value);
}

/**
 * Throws `GoalTamperError` unless `goal` came from `sealGoal` and still hashes
 * to its fingerprint. Pass `expectedFingerprint` when the host stored the
 * fingerprint separately, for example in the task record.
 */
export function assertGoalIntact(goal: SealedGoal, expectedFingerprint?: string): void {
  const goalId = typeof goal?.spec?.id === "string" ? goal.spec.id : "unknown";
  if (!isSealedGoal(goal)) {
    throw new GoalTamperError(
      goalId,
      `Goal ${goalId} was not sealed by sealGoal; refusing to validate.`,
    );
  }
  const actual = fingerprintGoalSpec(goal.spec);
  if (actual !== goal.fingerprint) {
    throw new GoalTamperError(
      goalId,
      `Goal ${goalId} changed after it was sealed; refusing to validate.`,
    );
  }
  if (expectedFingerprint !== undefined && expectedFingerprint !== goal.fingerprint) {
    throw new GoalTamperError(
      goalId,
      `Goal ${goalId} does not match the expected fingerprint; refusing to validate.`,
    );
  }
}
