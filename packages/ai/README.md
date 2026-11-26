# @generic-ai/ai

The provider-neutral model layer of the Generic AI native runtime. One message format and one
streaming event protocol over six wire APIs, using the official SDKs for transport and retries:

| API | Providers |
| --- | --- |
| `anthropic-messages` | Anthropic (API keys and Claude subscription OAuth tokens) |
| `openai-responses` | OpenAI |
| `openai-completions` | OpenRouter, Groq, xAI, DeepSeek, Mistral, Ollama, and any OpenAI-compatible server |
| `azure-openai-responses` | Azure OpenAI (`azure-openai/<model>`; endpoint from `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`, key `AZURE_OPENAI_API_KEY`, optional `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` and `AZURE_OPENAI_API_VERSION`) |
| `google-generative-ai` | Google Gemini (`google/<model>`, key `GEMINI_API_KEY` or `GOOGLE_API_KEY`) |
| `google-vertex` | Vertex AI (`google-vertex/<model>`, key `GOOGLE_CLOUD_API_KEY`, or application default credentials with `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`) |

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
- Gemini thinking: `thinkingLevel` on Gemini 3+, `thinkingBudget` on 2.5, explicitly off when no
  reasoning is asked for; thought signatures are replayed to the same model only.
- Usage and cost per response, including cache reads and writes.
- `isContextOverflow()` recognises context-overflow errors from every supported provider (and
  silent overflows when given the context window); `clampMaxTokensToContext()` fits an output
  budget into the window with a safety margin. Native sessions compact and retry once on overflow.
- `transformMessages()` makes a transcript safe to replay on a different model (foreign thinking is
  dropped, tool-call ids are normalised, orphaned tool calls get an error result).
- `validateToolArguments()` checks and coerces tool arguments against a JSON Schema.
- `registerFauxProvider()` is a scripted in-process provider for tests: queue responses, get
  realistic streaming, usage estimates, simulated prompt caching, pacing, and aborts.

The design follows pi's `pi-ai` package; see `THIRD_PARTY_NOTICES.md` and
`docs/planning/native-harness-parity.md` for what is covered and what is still to come.
