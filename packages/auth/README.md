# @generic-ai/auth

Credentials for the Generic AI native runtime: where API keys and OAuth tokens are stored, how they
are refreshed, and the building blocks for OAuth sign-in.

- **Stores.** The `CredentialStore` contract (`read`, `list`, `modify`, `delete`; `modify` is the
  only write path), `InMemoryCredentialStore`, and `FileCredentialStore`, a JSON file written with
  mode 0600 through an atomic rename, with a cross-process lock so several processes can share it.
- **Resolution.** `resolveAuth` and `createApiKeyResolver`. A stored credential owns its provider;
  the `fallback` (for example `resolveApiKey` from `@generic-ai/ai`, which reads environment
  variables) applies only when nothing is stored, never after a failed refresh. OAuth tokens with
  less than five minutes left are refreshed by `refreshStoredOAuthCredential` under the store lock,
  once across concurrent requests, and a rotated token is persisted even if the caller cancels.
- **Sign-in.** `login`, `saveApiKey` and `logout`; `generatePKCE`; `startOAuthCallbackServer` and
  `waitForCallbackOrManualInput` (a loopback redirect raced against a pasted redirect URL for remote
  sessions); `pollOAuthDeviceCodeFlow` (RFC 8628); `trustedHttpUrl`.
- **Providers.** `openRouterOAuth` / `createOpenRouterOAuth`: OpenRouter's PKCE flow for
  third-party apps, which mints a permanent API key.
- **Subscription sign-ins**, ported from pi: `anthropicOAuth` (Claude Pro/Max, PKCE with a loopback
  callback on port 53692 or a pasted code), `openaiCodexOAuth` (ChatGPT Plus/Pro through Codex, a
  browser flow on port 1455 or a device code; `login(..., { agentName })` sets the `originator`) and
  `githubCopilotOAuth` (GitHub device flow, then a short-lived Copilot token; GitHub Enterprise
  domains are supported). Each `toAuth` returns what a request needs: Claude's access token as the
  API key, Codex's access token plus the ChatGPT account id, and Copilot's token with its base URL
  and editor headers (`getGitHubCopilotBaseUrl`, `GITHUB_COPILOT_HEADERS`). These reuse those
  products' own OAuth clients, the same way pi does, so check each product's terms before using
  them. Use `createModelAuthResolver` (key, headers and base URL) rather than
  `createApiKeyResolver` for these, and pass it as `getAuth` to an `@generic-ai/agent` `Agent` or
  as `native.getAuth` to the core harness. The model references are `anthropic/<model>`,
  `openai-codex/<model>` and `github-copilot/<model>`.

```ts
import { createApiKeyResolver, FileCredentialStore, login, openRouterOAuth } from "@generic-ai/auth";
import { resolveApiKey } from "@generic-ai/ai";

const store = new FileCredentialStore({ path: "/home/me/.generic-ai/auth.json" });
await login(store, "openrouter", openRouterOAuth, {
  prompt: async (prompt) => readLineFromUser(prompt.message),
  notify: (event) => console.log(event),
});

const getApiKey = createApiKeyResolver({
  store,
  oauth: { openrouter: openRouterOAuth },
  fallback: (provider) => resolveApiKey(provider),
});
// new Agent({ ..., getApiKey })
```

The callback host defaults to `127.0.0.1`; set `GENERIC_AI_OAUTH_CALLBACK_HOST` to change it.

Adapted from [pi](https://github.com/badlogic/pi-mono) (MIT). See `THIRD_PARTY_NOTICES.md`.
