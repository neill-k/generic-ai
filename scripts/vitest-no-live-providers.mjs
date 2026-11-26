// Automated tests never call a real model (rule: no live LLM calls in automated tests).
// This setup file runs before every test file in `npm test` and CI. It removes provider
// credentials from the environment, so a test that would reach a real provider fails or skips
// instead of spending money, even when a developer's shell has a key exported.
// Live tests live in *.live.test.ts files, which `npm test` excludes; run them by hand with
// `npm run test:live -- <file>` (vitest.live.config.ts).

const CREDENTIAL = /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|_ACCESS_TOKEN)$/;
const EXPLICIT = [
  "GENERIC_AI_ENABLE_LIVE_SMOKE",
  "GENERIC_AI_LIVE_PROVIDER_API_KEY",
  "GENERIC_AI_PI_AUTH_JSON",
  "GENERIC_AI_LIVE_AGENT_DIR",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

for (const name of Object.keys(process.env)) {
  if (CREDENTIAL.test(name) || EXPLICIT.includes(name)) {
    delete process.env[name];
  }
}
