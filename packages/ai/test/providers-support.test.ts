import { describe, expect, it } from "vitest";

import { providerSupport, SUPPORTED_PROVIDERS } from "../src/index.js";

describe("provider support labels", () => {
  it("marks Anthropic and OpenAI supported and every other provider untested", () => {
    expect(SUPPORTED_PROVIDERS).toEqual(["anthropic", "openai", "openai-codex"]);
    expect(providerSupport("anthropic")).toBe("supported");
    expect(providerSupport("openai/gpt-5.5")).toBe("supported");
    expect(providerSupport("openai-codex/gpt-5.5")).toBe("supported");
    expect(providerSupport("groq/llama-4")).toBe("untested");
    expect(providerSupport("google")).toBe("untested");
    expect(providerSupport("amazon-bedrock/anthropic.claude-opus")).toBe("untested");
  });
});
