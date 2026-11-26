# @generic-ai/plugin-secrets

Secrets for Generic AI agents: they can **use** a credential without ever **seeing** it.

- Agents write `{{secret:NAME}}` in a tool input. The value is filled in when the tool runs, only
  if the agent's role was granted `NAME`.
- Every known secret value (and its base64, URL-encoded and JSON-escaped forms) is replaced with
  `[REDACTED:NAME]` in tool results, errors, events, traces and artifacts.
- Every use is audited as a `secret.read` policy decision, with names and actors, never values.

See `docs/decisions/0055-secrets-vault.md` for the design.

## Quick start

```ts
import { createAgentHarness } from "@generic-ai/core";
import { createSecretsFromEnvironment } from "@generic-ai/plugin-secrets";
import { openPostgresStorage } from "@generic-ai/plugin-storage-postgres";

const postgres = await openPostgresStorage(); // DATABASE_URL on Railway
const secrets = createSecretsFromEnvironment({ storage: postgres.storage });

const harness = createAgentHarness({
  id: "company",
  roles: [
    { id: "builder", kind: "builder", secrets: ["GITHUB_TOKEN"] },
    { id: "researcher", kind: "explorer", secrets: ["SEARCH_*"] },
    { id: "verifier", kind: "verifier" }, // no secrets
  ],
});

await harness.run({
  instruction: "Open a pull request for the fix.",
  workspaceRoot: "/srv/workspace",
  capabilities: { terminalTools, fileTools, secrets },
});
```

The builder can now run
`git push https://x-access-token:{{secret:GITHUB_TOKEN}}@github.com/org/repo.git`; the researcher and
verifier get a "not granted" error if they try.

## Where secrets come from

`createSecretsFromEnvironment` layers three sources; the first that holds a name wins.

| Source | How to set a secret | Notes |
| --- | --- | --- |
| Environment | `GENERIC_AI_SECRET_GITHUB_TOKEN=...` becomes `GITHUB_TOKEN` | Railway service variables or a local `.env`. Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) are exposed under their own names. Nothing else in the environment is. |
| Files | One file per secret in `GENERIC_AI_SECRETS_DIR` (default `/run/secrets`) | Docker and Compose `secrets:`. One trailing newline is stripped. |
| Encrypted store | `await secrets.set("NOTION_TOKEN", value, { updatedBy })` | Enabled when `GENERIC_AI_SECRETS_KEY` is set and you pass `storage`. AES-256-GCM, name bound as associated data, master key never stored. |

Generate a master key with `openssl rand -hex 32`. To rotate it, start with the new key and the old
one in `previousKeys` (`createEncryptedSecretStore`), call `rotate()`, then drop the old key.

Host-only names (`DATABASE_URL`, `GENERIC_AI_SECRETS_KEY`, `GENERIC_AI_AUTH_TOKEN`,
`GENERIC_AI_OWNER_SETUP_TOKEN`) are always redacted and can never be resolved by an agent, even with
a `*` grant.

## Grants

`role.secrets` (and `harness.secrets` for the root coordinator) accept:

- an exact name: `GITHUB_TOKEN`
- a prefix pattern: `GITHUB_*`
- everything except host-only names: `*`

No grant means no secrets. Roles are told the names they may use in their prompt.

## MCP servers

Pass the broker to the MCP client so `${VAR}` placeholders in server config resolve from the vault
first and the environment second, on every reconnect:

```ts
import { createMcpPlugin } from "@generic-ai/plugin-mcp";

const mcp = createMcpPlugin(config, { secrets });
```

## Host-side reads

`await secrets.get("ANTHROPIC_API_KEY", "provider-key")` reads without a grant check, registers the
value for redaction, and audits the read as actor `host`. `secrets.list()` returns names and
sources, never values.

## Limits

Redaction matches known values and their common encodings exactly. A value an agent splits or
re-encodes is not caught, and a value a command writes to a file stays in that file. Grants are the
primary control; redaction is defence in depth.
