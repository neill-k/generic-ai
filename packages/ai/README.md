# @generic-ai/ai

The provider-neutral model layer of the Generic AI native runtime. One message format and one
streaming event protocol over three wire APIs, using the official SDKs for transport and retries:

| API | Providers |
| --- | --- |
| `anthropic-messages` | Anthropic (API keys and Claude subscription OAuth tokens) |
| `openai-responses` | OpenAI |
| `openai-completions` | OpenRouter, Groq, xAI, DeepSeek, Mistral, Ollama, and any OpenAI-compatible server |

```ts
import { complete, resolveModel } from "@generic-ai/ai";

const model = resolveModel("anthropic/claude-opus-5-5");
const reply = await complete(model, {
  systemPrompt: "Be brief.",
  messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
}, { reasoning: "medium", sessionId: "conversation-1" });
```

What it covers:

- `stream()` never throws: a missing key, an HTTP failure, or an abort ends the stream with an
  `error` event whose message has `stopReason` `"error"` or `"aborted"`.
- Model references are `provider/model-id`. Catalog entries carry prices and limits; an unknown id
  for a known provider still resolves, and every field can be overridden (for example a proxy
  `baseUrl`).
- Thinking: adaptive thinking with `output_config.effort` on current Claude models, budget tokens
  on older ones, `reasoning.effort` on OpenAI, `reasoning_content` on compatible servers.
- Prompt caching: `cache_control` breakpoints for Anthropic (`cacheRetention: "long"` asks for the
  1 hour TTL), `prompt_cache_key` for OpenAI, keyed by `sessionId`.
- Usage and cost per response, including cache reads and writes.
- `transformMessages()` makes a transcript safe to replay on a different model (foreign thinking is
  dropped, tool-call ids are normalised, orphaned tool calls get an error result).
- `validateToolArguments()` checks and coerces tool arguments against a JSON Schema.
- `registerFauxProvider()` is a scripted in-process provider for tests: queue responses, get
  realistic streaming, usage estimates, simulated prompt caching, pacing, and aborts.

The design follows pi's `pi-ai` package; see `THIRD_PARTY_NOTICES.md` and
`docs/planning/native-harness-parity.md` for what is covered and what is still to come.
