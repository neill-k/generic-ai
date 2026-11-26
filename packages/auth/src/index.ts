export { AuthError, type AuthErrorCode } from "./errors.js";
export { FileCredentialStore, type FileCredentialStoreOptions } from "./file-store.js";
export { InMemoryCredentialStore } from "./memory-store.js";
export { anthropicOAuth } from "./oauth/anthropic.js";
export {
  type OAuthCallbackServer,
  type OAuthCallbackServerOptions,
  startOAuthCallbackServer,
  waitForCallbackOrManualInput,
} from "./oauth/callback-server.js";
export {
  abortableSleep,
  type OAuthDeviceCodePollOptions,
  type OAuthDeviceCodePollResult,
  pollOAuthDeviceCodeFlow,
} from "./oauth/device-code.js";
export {
  GITHUB_COPILOT_HEADERS,
  getGitHubCopilotBaseUrl,
  githubCopilotOAuth,
  isKnownGitHubCopilotModel,
} from "./oauth/github-copilot.js";
export { openaiCodexOAuth } from "./oauth/openai-codex.js";
export {
  createOpenRouterOAuth,
  OAUTH_CALLBACK_HOST_ENV,
  type OpenRouterOAuthOptions,
  openRouterOAuth,
} from "./oauth/openrouter.js";
export { oauthErrorHtml, oauthSuccessHtml } from "./oauth/page.js";
export { base64UrlEncode, generatePKCE } from "./oauth/pkce.js";
export { trustedHttpUrl } from "./oauth/trusted-url.js";
export {
  type CredentialResolverOptions,
  createApiKeyResolver,
  login,
  logout,
  type ResolvedAuth,
  refreshStoredOAuthCredential,
  resolveAuth,
  saveApiKey,
} from "./resolve.js";
export type {
  ApiKeyCredential,
  AuthEvent,
  AuthInteraction,
  AuthOperationOptions,
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
  LoginOptions,
  ModelAuth,
  OAuthCredential,
  OAuthCredentials,
  OAuthProvider,
  ProviderAuthInteraction,
} from "./types.js";
