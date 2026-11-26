// Adapted from pi (badlogic/pi-mono, packages/coding-agent/test/utilities.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { readFileSync } from "node:fs";

/** Create a minimal user message for testing. */
export function userMsg(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** Create a minimal assistant message for testing. */
export function assistantMsg(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

/** Read a session JSONL file and return the message role or entry type of each record. */
export function readSessionFileRoles(file: string): string[] {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((line) => {
      const record = JSON.parse(line);
      return record.message?.role ?? record.type;
    });
}

/** Read an array element that the test expects to exist. */
export function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Expected an element at index ${index}`);
  return item;
}
