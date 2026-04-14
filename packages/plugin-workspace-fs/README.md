# @generic-ai/plugin-workspace-fs

Local-filesystem workspace helpers for Generic AI.

This package stays intentionally small: it provides the canonical workspace layout, safe path resolution, and a tiny service object for code that needs to work with files under a local workspace root.

## What It Exposes

- `createWorkspaceLayout(root)`
- `createAgentWorkspaceLayout(root, agentId)`
- `createWorkspaceFs(root)`
- `ensureRecommendedWorkspaceStructure(root)`
- `ensureAgentWorkspaceStructure(root, agentId)`
- `resolveWorkspacePath(root, ...segments)`

## Canonical Layout

The default layout matches the planning docs:

```text
<root>/
  .generic-ai/
    agents/
    plugins/
  .agents/
    skills/
  workspace/
    agents/
      <agent-id>/
        memory/
        results/
    shared/
```

## Assumptions

- The root is local filesystem input, either a string path or a `file:` URL.
- `agentId` must be a single path segment, not a nested path.
- This package handles workspace path safety and layout scaffolding only; it does not define file tool business logic.

## Example

```ts
import {
  createWorkspaceFs,
  ensureRecommendedWorkspaceStructure,
} from "@generic-ai/plugin-workspace-fs";

const workspace = createWorkspaceFs(process.cwd());

await ensureRecommendedWorkspaceStructure(workspace.root);
const agent = workspace.createAgentWorkspaceLayout("primary");
```

## Planning Baseline

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
