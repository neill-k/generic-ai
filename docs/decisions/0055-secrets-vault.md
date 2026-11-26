# 0055 Secrets Vault: Placeholders, Role Grants, And Redaction

- Status: accepted
- Date: 2026-11-26
- Roadmap item: R12 (secrets vault)

## Context

Agents need credentials to do real work: provider keys for the model layer, tokens for MCP
servers, and keys for the services a role calls from its tools (GitHub, email, a CRM). Before this
change those values lived only in the process environment. Nothing stopped an agent from printing
`OPENAI_API_KEY` with a terminal or file tool, nothing scrubbed a key that leaked into a tool result,
and the canonical event stream, traces and artifacts stored whatever the model and tools produced.
There was no way to say that the builder may use the GitHub token but the researcher may not.

Generic Corp v1 runs on Railway with managed Postgres, uses Docker for local testing, and has a
single owner (D4, D5). The design has to fit that and must not grow tenant machinery.

## Decision

1. **SDK contract.** `@generic-ai/sdk` defines `SecretSource`, `WritableSecretSource`,
   `SecretAccessRecord`, the grant helper `isSecretGranted`, the `{{secret:NAME}}` placeholder
   syntax, and `SecretsBinding`: the only surface the harness depends on (`prepare`, `wrapTool`,
   `redact`, `redactText`, `grantedNames`).
2. **Agents use secrets, they never see them.** An agent writes `{{secret:NAME}}` in a tool input.
   The binding resolves it when the tool runs and only if the agent's role was granted `NAME`.
   Every known secret value, and its base64, URL-encoded and JSON-escaped forms, is replaced with
   `[REDACTED:NAME]` in tool results, partial updates and errors before the model sees them.
   Values shorter than four characters cannot be redacted safely and are reported at startup.
3. **Grants live on roles.** `role.secrets` (and `harness.secrets` for the root coordinator)
   accept exact names, `PREFIX_*` patterns, or `*`. No grant means no secrets. Roles are told the
   names they may use in their prompt; values never enter a prompt. Host-only names
   (`DATABASE_URL`, `GENERIC_AI_SECRETS_KEY`, `GENERIC_AI_AUTH_TOKEN`,
   `GENERIC_AI_OWNER_SETUP_TOKEN`) are redacted everywhere but no grant, not even `*`, resolves them.
4. **The harness wires it.** A host binds a broker as `capabilities.secrets`. The agent harness
   wraps each role's terminal, file and custom tools (including MCP tools and `delegate_agent`)
   after role policy and before lifecycle hooks, so hooks see placeholders rather than values. The
   run's canonical event stream gets a `redactData` hook, so listeners, snapshots and artifacts are
   scrubbed. Both the pi and native runtimes go through the same harness path.
5. **Every use is audited.** Each resolution attempt becomes a `policy.decision` with action
   `secret.read`, resource `secret:NAME`, and decision allowed or denied, in the run's policy
   decisions and event stream. Records carry names, actors and tools, never values.
6. **Where values live.** `@generic-ai/plugin-secrets` layers sources, first match wins:
   - environment variables: the provider keys, the host-only names, and anything prefixed
     `GENERIC_AI_SECRET_` (so `GENERIC_AI_SECRET_GITHUB_TOKEN` is secret `GITHUB_TOKEN`). Nothing else
     in the environment is exposed. On Railway these are service variables.
   - files: one per secret in `GENERIC_AI_SECRETS_DIR` or `/run/secrets` (Docker and Compose
     `secrets:`).
   - an encrypted store the owner can write at runtime, enabled when `GENERIC_AI_SECRETS_KEY` is set
     and the host passes storage. Values are encrypted with AES-256-GCM, the secret's name bound as
     associated data so rows cannot be swapped, and stored through any SDK `StorageContract`
     (Postgres KV on Railway). The master key never reaches storage. `previousKeys` plus `rotate()`
     re-encrypt without downtime.
7. **MCP credentials.** `createMcpClientManager({ secrets })` resolves `${VAR}` placeholders in MCP
   launch config and headers from the broker first and the environment second, on every
   (re)connect, so a rotated token is picked up on the next reconnect. Server stderr lines are
   redacted.
8. **Agent processes.** The plain terminal tool already starts commands with a minimal
   environment, so provider keys in the host environment are not visible to agent shells. The
   Docker sandbox now passes container env values to the Docker CLI by name (`--env KEY` with the
   value in the CLI's own environment) so they no longer appear on the command line, where `ps` and
   process logs could see them.

## Consequences

- A placeholder in a terminal command is substituted into the command text, so the value exists
  in the shell process for that command. It is scrubbed from output, but a command that writes it
  to a file in the workspace leaves it there. Roles that should never hold a credential should not
  be granted it.
- Redaction is exact-match on known values and their common encodings. A secret transformed in
  other ways (split, hashed, re-encoded twice) is not caught. This is defence in depth on top of
  grants, not a guarantee.
- The redactor only grows: rotated and deleted values keep being scrubbed for the life of the
  process.
- Provider keys keep their current lookup through the environment. Hosts that keep provider keys in
  the encrypted store read them with `broker.get(name, "provider-key")` and pass them to the native
  runtime's `apiKey` option.

## Follow-ups

- App API and dashboard settings to list, set and delete secrets (R13, R14), built on
  `broker.list/set/delete`.
- Grants on persistent agent records in `@generic-ai/plugin-delegation` so cascade turns run with
  the agent's grants.
- Per-provider key resolution through the broker in the native runtime once the native adapter
  (PR #110) lands.
- R11 approvals can require owner approval before a `secret.read` for chosen names.
