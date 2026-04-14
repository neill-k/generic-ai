# Pi Boundary

This directory captures the thin, documented boundary between Generic AI and
`@mariozechner/pi-coding-agent`.

## Directly exposed from `pi`

These are the `pi` primitives that Generic AI re-exports without adding a
second wrapper layer:

- runtime creation: `createAgentSession`, `createAgentSessionRuntime`
- runtime objects: `AgentSession`, `AgentSessionRuntime`
- runtime managers and loaders: `SessionManager`, `SettingsManager`, `AuthStorage`, `ModelRegistry`, `DefaultResourceLoader`
- runtime types: `AgentSessionConfig`, `AgentSessionEvent`, `AgentSessionEventListener`, `CreateAgentSessionOptions`, `CreateAgentSessionResult`, `CreateAgentSessionRuntimeFactory`, `CreateAgentSessionRuntimeResult`, `ModelCycleResult`, `PromptOptions`, `SessionStats`
- extension contracts: `defineTool`, `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `ExtensionFactory`, `ExtensionHandler`, `ToolDefinition`
- tool built-ins: `readTool`, `bashTool`, `editTool`, `writeTool`, `grepTool`, `findTool`, `lsTool`, `codingTools`, `readOnlyTools`, `createCodingTools`, `createReadOnlyTools`

## Kept Behind The Adapter

These `pi` surfaces stay behind `packages/core/src/runtime` instead of being
re-exported as part of the framework contract:

- low-level `pi-agent-core` and `pi-ai` model primitives
- TUI-specific extension UI types
- event-bus and renderer internals
- session persistence internals that belong to `pi`'s own runtime machinery
- any kernel-specific composition state, plugin-host wiring, or scope/session
  translation

## Rule Of Thumb

If a consumer would reasonably import the symbol while authoring an extension,
tool, or direct embedding, it is exposed directly. If the symbol only matters
while the kernel is translating `pi` into framework state, it stays behind the
core adapter.
