import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "./types.js";

const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
export const MISSING_TOOL_RESULT_TEXT = "No result provided";

function replaceImages(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): TextContent[] {
  const result: TextContent[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

function isSameModel(message: AssistantMessage, model: Model): boolean {
  return (
    message.provider === model.provider && message.api === model.api && message.model === model.id
  );
}

export type ToolCallIdNormalizer = (id: string, model: Model, source: AssistantMessage) => string;

/**
 * Prepare a transcript for one target model:
 *
 * - images become placeholders when the model is text-only;
 * - thinking from another model is dropped (its signatures are only valid for the model that made
 *   it, and readable thinking replayed as text confuses the new model); empty unsigned thinking is
 *   dropped;
 * - text signatures from another model are dropped;
 * - tool-call ids are rewritten through `normalizeToolCallId` for cross-model history, and the
 *   matching tool results follow;
 * - errored and aborted assistant turns are skipped (they may be incomplete);
 * - tool calls that never got a result get a synthetic error result, so every provider sees a
 *   well-formed call/result pairing.
 */
export function transformMessages(
  messages: readonly Message[],
  model: Model,
  normalizeToolCallId?: ToolCallIdNormalizer,
): Message[] {
  const idMap = new Map<string, string>();
  const supportsImages = model.input.includes("image");

  const transformed = messages.map((input): Message => {
    const message = (input.content == null ? { ...input, content: [] } : input) as Message;
    if (message.role === "user") {
      if (!supportsImages && Array.isArray(message.content)) {
        return { ...message, content: replaceImages(message.content, USER_IMAGE_PLACEHOLDER) };
      }
      return message;
    }
    if (message.role === "toolResult") {
      const content = supportsImages
        ? message.content
        : replaceImages(message.content, TOOL_IMAGE_PLACEHOLDER);
      const mapped = idMap.get(message.toolCallId);
      return {
        ...message,
        content,
        ...(mapped !== undefined ? { toolCallId: mapped } : {}),
      };
    }
    const sameModel = isSameModel(message, model);
    const content = message.content.flatMap((block): AssistantMessage["content"] => {
      if (block.type === "thinking") {
        if (!sameModel) {
          return [];
        }
        if (block.redacted || block.thinkingSignature) {
          return [block];
        }
        return block.thinking.trim() === "" ? [] : [block];
      }
      if (block.type === "text") {
        return [sameModel ? block : { type: "text", text: block.text }];
      }
      if (!sameModel && normalizeToolCallId) {
        const id = normalizeToolCallId(block.id, model, message);
        if (id !== block.id) {
          idMap.set(block.id, id);
          return [{ ...block, id }];
        }
      }
      return [block];
    });
    return { ...message, content };
  });

  const result: Message[] = [];
  let pending: ToolCall[] = [];
  let answered = new Set<string>();
  const closePending = () => {
    for (const call of pending) {
      if (!answered.has(call.id)) {
        result.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
          isError: true,
          timestamp: Date.now(),
        } satisfies ToolResultMessage);
      }
    }
    pending = [];
    answered = new Set();
  };

  for (const message of transformed) {
    if (message.role === "assistant") {
      closePending();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        continue;
      }
      const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
      if (calls.length > 0) {
        pending = calls;
        answered = new Set();
      }
      result.push(message);
    } else if (message.role === "toolResult") {
      answered.add(message.toolCallId);
      result.push(message);
    } else {
      closePending();
      result.push(message);
    }
  }
  closePending();
  return result;
}

/**
 * Deterministically shorten/sanitise a tool-call id to `^[a-zA-Z0-9_-]{1,maxLength}$` (the Anthropic
 * constraint). Ids that already match are returned unchanged.
 */
export function sanitizeToolCallId(id: string, maxLength = 64): string {
  if (/^[a-zA-Z0-9_-]+$/.test(id) && id.length <= maxLength) {
    return id;
  }
  // The hash keeps distinct ids distinct after cleaning and truncation.
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${cleaned.slice(0, maxLength - 9)}_${hash(id)}`;
}

function hash(value: string): string {
  // FNV-1a 32-bit, rendered as 8 hex chars.
  let hashValue = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 0x01000193) >>> 0;
  }
  return hashValue.toString(16).padStart(8, "0");
}
