/** A manually advanced clock for deterministic storage and queue tests. */
export interface ManualClock {
  now(): number;
  advance(ms: number): void;
  set(epochMs: number): void;
}

export function createManualClock(start = Date.parse("2026-01-01T00:00:00.000Z")): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(epochMs: number) {
      current = epochMs;
    },
  };
}
