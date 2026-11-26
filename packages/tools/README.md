# @generic-ai/tools

The coding tools of the Generic AI native runtime: `read`, `write`, `edit`, `bash`, `grep`, `find`,
and `ls`. They are adapted from pi's coding agent (MIT; see `THIRD_PARTY_NOTICES.md`) and return
`AgentTool`s for `@generic-ai/agent`.

```ts
import { Agent } from "@generic-ai/agent";
import { createCodingTools } from "@generic-ai/tools";

const agent = new Agent({
  initialState: { model, systemPrompt, tools: createCodingTools(process.cwd()) },
});
```

- `createCodingTools(cwd)` returns all seven tools; `createReadOnlyTools(cwd)` returns read, grep,
  find, and ls. Each tool also has a `create<Name>Tool` and a `create<Name>ToolDefinition` factory.
- Output is truncated to 2,000 lines or 50 KB. Bash keeps the full output in a temp file and says
  where.
- `edit` applies one or more exact replacements, with whitespace- and quote-tolerant matching, keeps
  line endings and BOMs, and returns a unified diff. Writes and edits to the same file are serialized
  by a per-file mutation queue.
- Every tool takes pluggable operations, so a host can point them at a remote or sandboxed workspace.
- `grep` needs ripgrep (`rg`). `find` uses `fd` when it is installed and otherwise a built-in search
  that follows fd's glob rules but does not read `.gitignore`. Tools are looked up in
  `GENERIC_AI_BIN_DIR` (default `~/.generic-ai/bin`) and on `PATH`; nothing is downloaded.
- Bash commands see `GENERIC_AI_SESSION_ID`, `GENERIC_AI_PROVIDER`, `GENERIC_AI_MODEL_ID`, and
  `GENERIC_AI_REASONING_LEVEL` when the host passes a tool context.
- `createToolSearchTool` gives the agent `tool_search` over deferred tools (for example many MCP
  tools): a BM25 ranker over names, descriptions and schema text loads the best matches so they are
  declared from the next model call. The core native session turns it on with `toolSearch`.
- Images read by `read` are attached as-is for PNG, JPEG, GIF, and WebP up to 5 MB; other formats
  are omitted with a note (pi resizes and converts them).
