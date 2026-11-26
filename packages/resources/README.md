# @generic-ai/resources

Skills, prompt templates and project context files for the Generic AI native runtime, adapted from pi's coding agent
(MIT; see `THIRD_PARTY_NOTICES.md`).

```ts
import {
  expandPromptTemplate,
  expandSkillCommand,
  formatSkillsForPrompt,
  loadPromptTemplates,
  loadSkills,
} from "@generic-ai/resources";

const { skills, diagnostics } = loadSkills({
  cwd,
  agentDir: "~/.generic-ai/agent",
  skillPaths: [],
  includeDefaults: true, // <agentDir>/skills and <cwd>/.generic-ai/skills
});
const systemPrompt = basePrompt + formatSkillsForPrompt(skills);

const { templates } = loadPromptTemplates({ cwd, agentDir, promptPaths: [], includeDefaults: true });
expandPromptTemplate("/review src/index.ts", templates); // template body with $1 filled in
expandSkillCommand("/skill:triage issue 42", skills); // <skill …>body</skill> then the arguments
```

- Skills follow the Agent Skills layout: a directory with `SKILL.md` is one skill; loose `.md`
  files at the top of a skills directory are skills when they have a `description`. Discovery
  honours `.gitignore`, `.ignore` and `.fdignore`, skips `node_modules`, follows symlinks, and
  reports invalid names, missing descriptions and name collisions as diagnostics.
- Skills with `disable-model-invocation: true` are left out of the prompt block and can only be
  run with `/skill:name`.
- Prompt templates are `.md` files; the file name is the command. `$1`, `$@`, `$ARGUMENTS`,
  `${1:-default}`, `${@:2}` and `${@:2:1}` are filled from bash-style quoted arguments.

## Project context files

`loadProjectContextFiles({ cwd, agentDir, stopAt })` returns the project instruction files an
agent should follow, as pi does: the global agent directory's file first, then one file per
directory from the outermost ancestor of `cwd` down to `cwd`. Each directory contributes its first
match from `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Inside a
nested linked git worktree, the main repository's copy of the worktree's file is skipped so the
same instructions are not applied twice. `stopAt` ends the walk at a directory, so a server can
keep its own instructions away from an agent's workspace.
`formatContextFilesForPrompt(files)` renders them as `<project_instructions path="…">` blocks.

In core, native sessions show them when `contextFiles` is set (`native.contextFiles` on a
harness): `true` climbs to the filesystem root, `{ stopAt: workspaceRoot }` stops at the
workspace. It is off by default.
