# Sandbox Migration Guide

This guide moves an existing Generic AI runtime from
`@generic-ai/plugin-tools-terminal` (host execution) to
`@generic-ai/plugin-tools-terminal-sandbox` (Docker-backed execution).

## Before And After

| Area | Host terminal | Sandbox terminal |
| --- | --- | --- |
| Execution location | Host workspace | Per-session container |
| `unrestrictedLocal` | `true` | `false` |
| Resource ceilings | Caller-defined timeout only | CPU, memory, disk, timeout, output caps |
| Network posture | Host networking | `isolated`, `allowlist`, or `open` |
| Workspace exposure | Host cwd | Read-only staging, explicit copy mode, or none |
| Artifact handling | Whatever the command writes on the host | Explicit output directory plus artifact metadata |

## Tested Migration Path

The migration path documented here is covered by repository tests:

- `packages/preset-starter-hono/src/index.test.ts` verifies the starter preset
  can swap the `terminalTools` slot to
  `@generic-ai/plugin-tools-terminal-sandbox`
- `packages/plugin-tools-terminal-sandbox/test/index.test.ts` verifies runtime
  behavior, network modes, copy mode, cleanup, and live-Docker scenarios
- `packages/sdk/test/contracts/sandbox-contract.test.ts` verifies the public
  contract, parser helpers, and schema-level behavior

## Step 1: Inventory Current Host Terminal Usage

Search for:

- `@generic-ai/plugin-tools-terminal`
- `terminalTools`
- callers that depend on host-side side effects or ambient network access

You need to know whether the current runtime:

- writes files directly into the workspace
- depends on outbound network access
- emits very large stdout/stderr streams
- expects long-running commands with no timeout ceiling

Those assumptions determine the policy you need in later steps.

## Step 2: Add Sandbox Defaults

Create `.generic-ai/plugins/tools-terminal-sandbox.yaml`:

```yaml
plugin: "@generic-ai/plugin-tools-terminal-sandbox"
defaultRuntime: node
ensureImages: true
defaultPolicy:
  resources:
    cpuCores: 1
    memoryMb: 512
    diskMb: 100
    timeoutMs: 30000
    timeoutGraceMs: 5000
  network:
    mode: isolated
  files:
    mode: readonly-mount
    outputDir: workspace/shared/sandbox-results
```

Start with the conservative defaults unless you already know the workload needs
larger limits.

## Step 3: Switch The Starter Preset Slot

Replace the starter preset's terminal slot explicitly:

```ts
const bootstrap = await createStarterHonoBootstrapFromYaml({
  startDir: process.cwd(),
  slotOverrides: [
    {
      slot: "terminalTools",
      pluginId: "@generic-ai/plugin-tools-terminal-sandbox",
      description: "Docker-backed sandbox terminal execution.",
    },
  ],
});
```

This preserves the rest of the starter stack and changes only the terminal
implementation.

## Step 4: Keep Caller Expectations Stable

Most callers can keep their current result handling because the sandbox result
surface is intentionally compatible with the host-terminal shape:

- `output` is still present
- `timedOut` is still present
- `cwd` still refers to the host working directory
- `unrestrictedLocal` still exists, but is always `false`

New fields that you should start using during the migration:

- `sandboxCwd`
- `status`
- `stdout` and `stderr`
- `truncated`, `stdoutTruncated`, `stderrTruncated`
- `artifacts` / `generatedFiles`
- `resourceUsage`

## Step 5: Tighten File And Network Exposure

Move from permissive assumptions to explicit policy:

- keep `network.mode: isolated` unless the workload truly needs outbound access
- when access is required, prefer `allowlist` over `open`
- keep `files.mode: readonly-mount` unless the command needs a writable working
  copy
- if you need writable workspace inputs, use `files.mode: copy` with explicit
  `copyInPaths` and `copyOutPaths`

Avoid carrying host-execution assumptions into the sandbox unchanged. The whole
point of the migration is to replace ambient host privileges with explicit
policy.

## Step 6: Validate The New Path

Run:

```bash
npx vitest run packages/preset-starter-hono/src/index.test.ts
npx vitest run packages/sdk/test/contracts/sandbox-contract.test.ts packages/plugin-tools-terminal-sandbox/test/index.test.ts
```

Then exercise one or two real commands and verify:

- the command still completes successfully
- outputs appear where you expect
- artifacts land under the configured `outputDir`
- resource and network limits are appropriate for the workload

## Step 7: Roll Out In Stages

Recommended order:

1. local development
2. CI or ephemeral preview environments
3. staging
4. production

Keep one small smoke workload that proves:

- container creation succeeds
- the command can read the expected workspace inputs
- artifacts are copied back correctly
- cleanup leaves no leaked containers or networks behind

## Proposed Deprecation Timeline

This is a rollout proposal, not a hard-coded enforcement policy yet.

### Phase 0: Current state

- `@generic-ai/plugin-tools-terminal` remains supported for local development
  and tests
- production adopters should migrate to the sandbox plugin now

### Phase 1: After the sandbox stack lands on the default path

- all production-oriented docs and examples should point to the sandbox plugin
  first
- host-terminal docs should be labeled "local development only"

### Phase 2: After deferred runtime-governance work lands

- production runtimes should warn, and eventually fail policy review, when they
  still choose unrestricted host execution without an explicit exception

### Phase 3: Next breaking-surface cleanup

- no production preset or reference example should ship with unrestricted host
  execution as the default terminal choice
- `@generic-ai/plugin-tools-terminal` remains available only as an explicit
  local-development opt-in
