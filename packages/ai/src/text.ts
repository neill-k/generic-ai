// Adapted from pi (badlogic/pi-mono, packages/ai/src/utils/text.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "./types.js";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** Extract and join text from message content. */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join(separator);
}

/**
 * `text.slice(start, end)` as a string of its own, so a short excerpt does not keep a large source
 * string alive (V8 represents longer slices as views into the original).
 */
export function ownedSlice(text: string, start: number, end = text.length): string {
  return `${text.slice(start, end)} `.slice(0, -1);
}
