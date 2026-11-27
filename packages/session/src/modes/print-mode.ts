// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/modes/print-mode.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
//
// Print mode: send one or more prompts, write the result and return an exit code. `text` writes
// the final answer only; `json` writes the session header and then every agent event as JSON lines.

import type { ImageContent } from "@generic-ai/ai";
import {
  type AgentModeHost,
  bindPersistence,
  lastAssistantMessage,
  runHostPrompt,
} from "./host.js";
import { serializeJsonLine } from "./jsonl.js";

export interface PrintModeOptions {
  /** `text` for the final response only, `json` for every event. */
  readonly mode: "text" | "json";
  /** The first prompt. */
  readonly initialMessage?: string | undefined;
  /** Images attached to the first prompt. */
  readonly initialImages?: ImageContent[] | undefined;
  /** Prompts sent one after another once the first is done. */
  readonly messages?: readonly string[] | undefined;
  /** Standard output. Defaults to `process.stdout`. */
  readonly write?: ((text: string) => void) | undefined;
  /** Standard error. Defaults to `process.stderr`. */
  readonly writeError?: ((text: string) => void) | undefined;
}

/**
 * Run the prompts and return the exit code: 0 on success, 1 when the last answer failed, was
 * aborted or was cut off at the output token limit, or when a prompt threw.
 */
export async function runPrintMode(
  host: AgentModeHost,
  options: PrintModeOptions,
): Promise<number> {
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const writeError = options.writeError ?? ((text: string) => void process.stderr.write(text));
  const agent = host.agent;
  let exitCode = 0;

  const unsubscribe =
    options.mode === "json"
      ? agent.subscribe((event) => write(serializeJsonLine(event)))
      : () => {};
  const stopPersisting = bindPersistence(host);

  try {
    if (options.mode === "json") {
      const header = host.sessionManager?.getHeader();
      if (header !== undefined && header !== null) write(serializeJsonLine(header));
    }
    if (options.initialMessage !== undefined) {
      await runHostPrompt(host, options.initialMessage, options.initialImages);
    }
    for (const message of options.messages ?? []) {
      await runHostPrompt(host, message);
    }

    const messages = agent.state.messages;
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      const assistant = lastAssistantMessage(messages);
      if (assistant !== undefined) {
        if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
          writeError(`${assistant.errorMessage ?? `Request ${assistant.stopReason}`}\n`);
          exitCode = 1;
        } else {
          if (options.mode === "text") {
            for (const block of assistant.content) {
              if (block.type === "text") write(`${block.text}\n`);
            }
          }
          if (assistant.stopReason === "length") {
            writeError("Response was truncated: the model reached its output token limit.\n");
            exitCode = 1;
          }
        }
      }
    }
    return exitCode;
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    unsubscribe();
    stopPersisting();
    await host.dispose?.();
  }
}
