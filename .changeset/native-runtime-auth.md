---
"@generic-ai/auth": minor
---

New package: credentials for the native runtime. A `CredentialStore` contract with in-memory and JSON file stores (mode 0600, atomic replace, cross-process lock); auth resolution where a stored credential owns its provider; OAuth refresh that runs once under the store lock and always persists a rotated token; PKCE, a loopback callback server with a paste-the-redirect fallback, RFC 8628 device-code polling; OpenRouter's PKCE sign-in; and `createApiKeyResolver` for `AgentOptions.getApiKey`.
