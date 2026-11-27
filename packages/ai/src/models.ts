import { GITHUB_COPILOT_BASE_URL, githubCopilotApi } from "./providers/github-copilot.js";
import { DEFAULT_CODEX_BASE_URL } from "./providers/openai-codex-responses.js";
import type { Api, Model, ProviderId } from "./types.js";

/**
 * Built-in model catalog and model references.
 *
 * A model reference is `"provider/model-id"` (for example `"anthropic/claude-opus-5-5"` or
 * `"openrouter/qwen/qwen3-coder"`). Catalog entries carry prices and limits; an id that is not in
 * the catalog still resolves for a known provider, using the provider's defaults, so new models work
 * before the catalog learns about them. Config can override any field.
 */

interface ProviderDefaults {
  readonly api: Api;
  readonly baseUrl: string;
}

/**
 * The supported providers: Anthropic (API keys and Claude subscription sign-in) and OpenAI (API
 * keys and ChatGPT sign-in through the Codex backend). Every other provider runs through the same
 * code but is untested: it may work, and nobody has checked.
 */
export const SUPPORTED_PROVIDERS: readonly string[] = Object.freeze([
  "anthropic",
  "openai",
  "openai-codex",
]);

export type ProviderSupport = "supported" | "untested";

/** Whether a provider (or the provider of a `provider/model` reference) is supported or untested. */
export function providerSupport(providerOrRef: string): ProviderSupport {
  const provider = providerOrRef.includes("/")
    ? providerOrRef.slice(0, providerOrRef.indexOf("/"))
    : providerOrRef;
  return SUPPORTED_PROVIDERS.includes(provider) ? "supported" : "untested";
}

export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  groq: { api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
  xai: { api: "openai-completions", baseUrl: "https://api.x.ai/v1" },
  deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" },
  mistral: { api: "mistral-conversations", baseUrl: "https://api.mistral.ai" },
  ollama: { api: "openai-completions", baseUrl: "http://localhost:11434/v1" },
  google: {
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  // Empty: the SDK builds the regional endpoint from the project and location.
  "google-vertex": { api: "google-vertex", baseUrl: "" },
  // Set the resource URL (`https://<resource>.openai.azure.com/openai/v1`) or AZURE_OPENAI_BASE_URL.
  "azure-openai": { api: "azure-openai-responses", baseUrl: "" },
  // Model ids are Bedrock ids or inference profiles (`us.anthropic.claude-opus-5-5-v1:0`, ARNs).
  // The region comes from AWS_REGION or the profile; set a base URL for a VPC endpoint or proxy.
  "amazon-bedrock": { api: "bedrock-converse-stream", baseUrl: "" },
  // OpenAI-compatible and Anthropic-compatible hosted providers (base URLs from pi's catalog).
  cerebras: { api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
  fireworks: { api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1" },
  together: { api: "openai-completions", baseUrl: "https://api.together.ai/v1" },
  huggingface: { api: "openai-completions", baseUrl: "https://router.huggingface.co/v1" },
  nvidia: { api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1" },
  baseten: { api: "openai-completions", baseUrl: "https://inference.baseten.co/v1" },
  moonshotai: { api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" },
  "moonshotai-cn": { api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" },
  "kimi-coding": { api: "openai-completions", baseUrl: "https://api.kimi.com/coding/v1" },
  zai: { api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  xiaomi: { api: "openai-completions", baseUrl: "https://api.xiaomimimo.com/v1" },
  minimax: { api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic" },
  "minimax-cn": { api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic" },
  "vercel-ai-gateway": { api: "anthropic-messages", baseUrl: "https://ai-gateway.vercel.sh" },
  meta: { api: "openai-responses", baseUrl: "https://api.meta.ai/v1" },
  // ChatGPT Plus/Pro sign-in (openaiCodexOAuth in @generic-ai/auth).
  "openai-codex": { api: "openai-codex-responses", baseUrl: DEFAULT_CODEX_BASE_URL },
  // GitHub Copilot sign-in (githubCopilotOAuth); the API depends on the model, see githubCopilotApi.
  "github-copilot": { api: "openai-completions", baseUrl: GITHUB_COPILOT_BASE_URL },
};

function claude(id: string, name: string, input: number, output: number, cacheRead: number): Model {
  return {
    id,
    name,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: PROVIDER_DEFAULTS["anthropic"]?.baseUrl ?? "",
    reasoning: true,
    thinkingMode: "adaptive",
    input: ["text", "image"],
    // Cache writes (5 minute TTL) cost 1.25x input.
    cost: { input, output, cacheRead, cacheWrite: input * 1.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };
}

/** Catalog snapshot (prices in USD per million tokens, Anthropic first-party rates as of 2026-11). */
const CATALOG: Model[] = [
  claude("claude-opus-5-5", "Claude Opus 5.5", 4, 20, 0.2),
  claude("claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, 0.1),
  claude("claude-haiku-5-5", "Claude Haiku 5.5", 0.1, 0.5, 0.01),
  claude("claude-fable-5-2", "Claude Fable 5.2", 8, 40, 0.2),
  claude("claude-opus-5", "Claude Opus 5", 5, 25, 0.5),
  claude("claude-sonnet-5", "Claude Sonnet 5", 2, 10, 0.2),
  claude("claude-opus-4-8", "Claude Opus 4.8", 5, 25, 0.5),
  claude("claude-sonnet-4-6", "Claude Sonnet 4.6", 3, 15, 0.3),
  {
    ...claude("claude-haiku-4-5", "Claude Haiku 4.5", 1, 5, 0.1),
    thinkingMode: "budget",
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

const customModels = new Map<string, Model>();

function key(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** Add or replace a model in the catalog (for example from config). */
export function registerModel(model: Model): void {
  customModels.set(key(model.provider, model.id), model);
}

export function listModels(provider?: ProviderId): Model[] {
  const all = new Map<string, Model>();
  for (const model of CATALOG) {
    all.set(key(model.provider, model.id), model);
  }
  for (const [modelKey, model] of customModels) {
    all.set(modelKey, model);
  }
  return [...all.values()].filter((model) => provider === undefined || model.provider === provider);
}

/** Look up a catalog model. */
export function getModel(provider: ProviderId, id: string): Model | undefined {
  return (
    customModels.get(key(provider, id)) ??
    CATALOG.find((model) => model.provider === provider && model.id === id)
  );
}

/** Split `"provider/model-id"`. The model id may itself contain slashes. */
export function parseModelRef(ref: string): { provider: string; id: string } {
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) {
    throw new Error(`Invalid model reference "${ref}": expected "provider/model-id".`);
  }
  return { provider: ref.slice(0, separator), id: ref.slice(separator + 1) };
}

export type ModelOverrides = Partial<Omit<Model, "provider" | "id">>;

/**
 * Resolve a model reference to a full model: the catalog entry if known, else provider defaults.
 * `overrides` replace individual fields (base URL for a proxy, prices, limits, compat flags).
 */
export function resolveModel(
  ref: string | { provider: string; id: string },
  overrides: ModelOverrides = {},
): Model {
  const { provider, id } = typeof ref === "string" ? parseModelRef(ref) : ref;
  const known = getModel(provider, id);
  if (known) {
    return { ...known, ...overrides };
  }
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults && (overrides.api === undefined || overrides.baseUrl === undefined)) {
    throw new Error(
      `Unknown provider "${provider}" for model "${id}". Known providers: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}; or pass api and baseUrl.`,
    );
  }
  // Gemini 2.5 and later think and have a 1M-token window; other unknown models get conservative limits.
  const gemini =
    (provider === "google" || provider === "google-vertex") &&
    /gemini-(?:2\.5|[3-9]|\d{2,})|gemini-flash(?:-lite)?-latest/.test(id.toLowerCase());
  // Magistral models reason through `prompt_mode`; others need a `thinkingLevelMap` from config.
  const magistral = provider === "mistral" && id.toLowerCase().startsWith("magistral");
  return {
    id,
    name: id,
    api:
      provider === "github-copilot"
        ? githubCopilotApi(id)
        : (defaults?.api ?? "openai-completions"),
    provider,
    baseUrl: defaults?.baseUrl ?? "",
    reasoning:
      provider === "anthropic" ||
      provider === "openai" ||
      provider === "openai-codex" ||
      provider === "azure-openai" ||
      gemini ||
      magistral,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: gemini ? 1_048_576 : 200_000,
    maxTokens: gemini ? 65_536 : 32_000,
    ...overrides,
  };
}
