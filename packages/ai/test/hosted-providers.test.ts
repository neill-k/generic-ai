import { afterEach, describe, expect, it, vi } from "vitest";
import { complete, PROVIDER_API_KEY_ENV, resolveApiKey, resolveModel } from "../src/index.js";

/** Built-in defaults for hosted providers: base URL, wire API and key variable. No network. */

const expected: Array<[string, string, string, string]> = [
  ["cerebras", "openai-completions", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"],
  ["fireworks", "openai-completions", "https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY"],
  ["together", "openai-completions", "https://api.together.ai/v1", "TOGETHER_API_KEY"],
  ["huggingface", "openai-completions", "https://router.huggingface.co/v1", "HF_TOKEN"],
  ["nvidia", "openai-completions", "https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY"],
  ["baseten", "openai-completions", "https://inference.baseten.co/v1", "BASETEN_API_KEY"],
  ["moonshotai", "openai-completions", "https://api.moonshot.ai/v1", "MOONSHOT_API_KEY"],
  ["moonshotai-cn", "openai-completions", "https://api.moonshot.cn/v1", "MOONSHOT_API_KEY"],
  ["kimi-coding", "openai-completions", "https://api.kimi.com/coding/v1", "KIMI_API_KEY"],
  ["zai", "openai-completions", "https://api.z.ai/api/coding/paas/v4", "ZAI_API_KEY"],
  ["xiaomi", "openai-completions", "https://api.xiaomimimo.com/v1", "XIAOMI_API_KEY"],
  ["minimax", "anthropic-messages", "https://api.minimax.io/anthropic", "MINIMAX_API_KEY"],
  ["minimax-cn", "anthropic-messages", "https://api.minimaxi.com/anthropic", "MINIMAX_CN_API_KEY"],
  ["vercel-ai-gateway", "anthropic-messages", "https://ai-gateway.vercel.sh", "AI_GATEWAY_API_KEY"],
  ["meta", "openai-responses", "https://api.meta.ai/v1", "META_API_KEY"],
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hosted provider defaults", () => {
  it.each(expected)("%s resolves to %s at %s, key from %s", (provider, api, baseUrl, env) => {
    const model = resolveModel(`${provider}/some-model`);
    expect(model.api).toBe(api);
    expect(model.baseUrl).toBe(baseUrl);
    expect(PROVIDER_API_KEY_ENV[provider]).toContain(env);
    vi.stubEnv(env, `key-for-${provider}`);
    expect(resolveApiKey(provider)).toBe(`key-for-${provider}`);
  });

  it("sends Chat Completions requests to the provider's endpoint with its key", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "cb-key");
    const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const chunk = {
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "llama-4",
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const message = await complete(
      resolveModel("cerebras/llama-4"),
      { systemPrompt: "Be brief.", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { maxRetries: 0, maxTokens: 64, fetch: fetchStub },
    );
    expect(message.stopReason).toBe("stop");
    expect(requests[0]?.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(requests[0]?.auth).toBe("Bearer cb-key");
    // Conservative compat for non-OpenAI hosts: system role and max_tokens.
    expect(requests[0]?.body["max_tokens"]).toBe(64);
    const messages = requests[0]?.body["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("system");
  });
});
