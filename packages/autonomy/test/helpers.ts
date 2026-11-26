import type { AssistantMessage, Usage } from "@generic-ai/ai";

export function usage(input: number, output: number, cacheWrite = 0, cacheRead = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function turn(
  timestamp: number,
  options: {
    text?: string;
    stopReason?: AssistantMessage["stopReason"];
    errorMessage?: string;
    usage?: Usage;
  } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: options.text === undefined ? [] : [{ type: "text", text: options.text }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage: options.usage ?? usage(0, 0),
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    timestamp,
  } as AssistantMessage;
}

export function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
