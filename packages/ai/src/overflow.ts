// Context-overflow detection and output clamping. Adapted from pi's `utils/overflow.ts` and
// `clampMaxTokensToContext` in `api/simple-options.ts` (badlogic/pi-mono, MIT).

import type { AssistantMessage, Model } from "./types.js";

/**
 * Error messages providers return when the input exceeds the model's context window or the request
 * size limit (Anthropic, OpenAI, Gemini, Bedrock, xAI, Groq, OpenRouter, Together, llama.cpp, LM
 * Studio, Copilot, MiniMax, Kimi, Mistral, z.ai, Ollama, DashScope, and generic fallbacks).
 */
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
  /prompt exceeds max length/i, // z.ai CN endpoint token overflow
  /(?<![a-z0-9_])request_too_large(?![a-z0-9_])/i, // Anthropic request byte-size error code, not a longer identifier
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /context window exceeded/i, // LiteLLM pre-call check (ContextWindowExceededError)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  // HTTP 413 means request-size overflow regardless of provider or body text.
  // Match raw SDK errors and formatProviderError's prefix, not a status mentioned in the body.
  /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];

const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/**
 * Patterns that indicate non-overflow errors (e.g. rate limiting, server errors).
 * Error messages matching any of these are excluded from overflow detection
 * even if they also match an OVERFLOW_PATTERN.
 *
 * Example: Bedrock formats throttling errors as "ThrottlingException: Too many tokens,
 * please wait before trying again." which would match the /too many tokens/i overflow
 * pattern without this exclusion.
 */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles three cases:
 * 1. Error-based overflow: Most providers return stopReason "error" with a
 *    specific error message pattern.
 * 2. Silent overflow: Some providers accept overflow requests and return
 *    successfully. For these, we check if usage.input exceeds the context window.
 * 3. Length-stop overflow: Xiaomi MiMo can return "length" with zero output when
 *    the input fills the context window.
 *
 * ## Reliability by Provider
 *
 * **Reliable detection (returns error with detectable message):**
 * - Anthropic: "prompt is too long: X tokens > Y maximum" or "request_too_large"
 * - OpenAI (Completions & Responses): "exceeds the context window", "exceeds the model's maximum context length of X tokens", or "exceeds model's maximum context length (X)"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - GitHub Copilot: HTTP 413 "failed to parse request" (request byte-size overflow)
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter (most backends): "maximum context length is X tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - DashScope/Qwen: "Range of input length should be [1, X]"
 * - z.ai: "Prompt too long"
 *
 * **Unreliable detection:**
 * - z.ai: Sometimes accepts overflow silently (detectable via usage.input > contextWindow),
 *   sometimes returns rate limit errors. Pass contextWindow param to detect silent overflow.
 * - Xiaomi MiMo: Truncates input to fit contextWindow then returns stopReason "length" with
 *   output=0. Pass contextWindow param to detect via the "filled context + zero output" signal.
 * - Ollama: May truncate input silently for some setups, but may also return explicit
 *   overflow errors that match the patterns above. Silent truncation still cannot be
 *   detected here because we do not know the expected token count.
 *
 * ## Custom Providers
 *
 * If you've added custom models via settings.json, this function may not detect
 * overflow errors from those providers. To add support:
 *
 * 1. Send a request that exceeds the model's context window
 * 2. Check the errorMessage in the response
 * 3. Create a regex pattern that matches the error
 * 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or
 *    check the errorMessage yourself before calling this function
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional context window size for detecting silent overflow (z.ai)
 * @returns true if the message indicates a context overflow
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  // Case 1: Check error message patterns
  const errorMessage = message.errorMessage;
  if (message.stopReason === "error" && errorMessage) {
    // Skip messages matching known non-overflow patterns (e.g. throttling / rate-limit)
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
    if (!isNonOverflow) {
      if (OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))) {
        return true;
      }
      if (
        message.provider === "cerebras" &&
        CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(errorMessage)
      ) {
        return true;
      }
    }
  }

  // Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
  if (contextWindow && message.stopReason === "stop") {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens > contextWindow) {
      return true;
    }
  }

  // Case 3: Length-stop overflow (Xiaomi MiMo style) - server truncates oversized input
  // to fit the context window, leaving no room for output. Returns stopReason "length"
  // with output=0 and input+cacheRead filling the context window.
  if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens >= contextWindow * 0.99) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether a length stop ended below the caller or model's intended output limit.
 * Such responses may be caused by context pressure or provider-side truncation, so callers
 * can make one bounded compact-and-retry attempt. `desiredMaxOutput` must be the original
 * limit before any context-based clamping.
 */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
  return (
    message.stopReason === "length" &&
    desiredMaxOutput > 0 &&
    message.usage.output < desiredMaxOutput
  );
}

/**
 * Get the overflow patterns for testing purposes.
 */
export function getOverflowPatterns(): RegExp[] {
  return [...OVERFLOW_PATTERNS];
}

const CONTEXT_SAFETY_TOKENS = 4096;
const CONTEXT_SAFETY_RATIO = 0.15;
const MIN_OUTPUT_WITH_RATIO_MARGIN = 32_768;

/**
 * Fit an output budget into the context window, leaving room for the provider counting the input
 * higher than estimated: the larger of 4096 tokens and 15% of the input, relaxed to the fixed margin
 * when that leaves under 32768 tokens, and never below 1.
 */
export function clampMaxTokensToContext(
  model: Pick<Model, "contextWindow">,
  inputTokens: number,
  maxTokens: number,
): number {
  if (model.contextWindow <= 0) {
    return Math.max(1, maxTokens);
  }
  const margin = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(inputTokens * CONTEXT_SAFETY_RATIO));
  let room = model.contextWindow - inputTokens - margin;
  if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
    room = Math.min(
      MIN_OUTPUT_WITH_RATIO_MARGIN,
      model.contextWindow - inputTokens - CONTEXT_SAFETY_TOKENS,
    );
  }
  return Math.min(maxTokens, Math.max(1, room));
}
