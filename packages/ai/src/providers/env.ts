/** Environment variables holding each provider's API key, first match wins. */
export const PROVIDER_API_KEY_ENV: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  // Vertex falls back to application default credentials when no key is set.
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  "azure-openai": ["AZURE_OPENAI_API_KEY"],
  // Bedrock API keys; without one the AWS credential chain signs requests.
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
  cerebras: ["CEREBRAS_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  huggingface: ["HF_TOKEN"],
  nvidia: ["NVIDIA_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  zai: ["ZAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  meta: ["META_API_KEY"],
  // Local servers accept any key.
  ollama: ["OLLAMA_API_KEY"],
};

/** Resolve the API key for a provider: explicit key, then the provider's environment variables. */
export function resolveApiKey(provider: string, explicit?: string): string | undefined {
  if (explicit) {
    return explicit;
  }
  for (const name of PROVIDER_API_KEY_ENV[provider] ?? [
    `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
  ]) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }
  return provider === "ollama" ? "ollama" : undefined;
}
