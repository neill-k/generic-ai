# @generic-ai/ai

The provider-neutral model layer of the Generic AI native runtime. One message format and one
streaming event protocol over eight wire APIs, using the official SDKs (or plain `fetch` with the same retry policy) for
transport and retries:

| API | Providers | Status |
| --- | --- | --- |
| `anthropic-messages` | Anthropic (API keys; Claude plan sign-in tokens are refused, since Anthropic's terms don't allow third-party apps to use them), and the Anthropic-compatible MiniMax (`minimax`, `minimax-cn`) and Vercel AI Gateway (`vercel-ai-gateway`, `AI_GATEWAY_API_KEY`) | Anthropic: supported. MiniMax, Vercel AI Gateway: untested |
| `openai-responses` | OpenAI, Meta (`meta`, `META_API_KEY`) | OpenAI: supported. Meta: untested |
| `openai-codex-responses` | ChatGPT Plus/Pro through the Codex backend (`openai-codex/<model>`; sign in with `openaiCodexOAuth` from `@generic-ai/auth`; server-sent events, stateless with encrypted reasoning, system prompt as a developer item) | Supported |
| `openai-completions` | OpenRouter, Groq, xAI, DeepSeek, Ollama, Cerebras, Fireworks, Together, Hugging Face (`HF_TOKEN`), NVIDIA, Baseten, Moonshot (`moonshotai`, `moonshotai-cn`), Kimi Coding, Z.ai, Xiaomi, and any OpenAI-compatible server | Untested |
| `mistral-conversations` | Mistral native (`mistral/<model>`, key `MISTRAL_API_KEY`): thinking chunks, 9-character tool-call ids, `reasoning_effort` through a model's `thinkingLevelMap` or `prompt_mode` for Magistral, prompt-cache key and `x-affinity` from the session id | Untested |
| `azure-openai-responses` | Azure OpenAI (`azure-openai/<model>`; endpoint from `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`, key `AZURE_OPENAI_API_KEY`, optional `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` and `AZURE_OPENAI_API_VERSION`) | Untested |
| `bedrock-converse-stream` | Amazon Bedrock (`amazon-bedrock/<model id or inference profile>`; region from `AWS_REGION`, an inference-profile ARN or `AWS_PROFILE`; auth by Bedrock API key `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or the AWS credential chain; a base URL for VPC endpoints or proxies; `AWS_BEDROCK_FORCE_CACHE=1` and `AWS_BEDROCK_SKIP_AUTH=1` for inference profiles and auth-adding proxies) | Untested |
| Per model | GitHub Copilot (`github-copilot/<model>`; sign in with `githubCopilotOAuth`): Claude 4.x and 5.x on `anthropic-messages` with bearer auth, GPT, Grok, OSWE and MAI on `openai-responses`, the rest on `openai-completions`; `X-Initiator`, `Openai-Intent` and `Copilot-Vision-Request` are added per request | Untested |
| `google-generative-ai` | Google Gemini (`google/<model>`, key `GEMINI_API_KEY` or `GOOGLE_API_KEY`) | Untested |
| `google-vertex` | Vertex AI (`google-vertex/<model>`, key `GOOGLE_CLOUD_API_KEY`, or application default credentials with `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`) | Untested |

Only Anthropic and OpenAI are supported. Every other provider runs through the same code and may
well work, but nobody has checked it; treat it as untested. `SUPPORTED_PROVIDERS` and
`providerSupport("provider/model")` say which is which, and Generic Corp logs a line at startup for
each model it uses from an untested provider.

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
- Virtual models: `registerVirtualModel({ provider, id, route })` adds a catalog entry whose router
  picks the physical model and reasoning level for each request; responses name the model that
  answered, and the caller's key is only forwarded to a routed model of the same provider.
  `createFallbackModel({ provider, id, models })` tries models in order and moves on when one
  fails before producing output.
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
