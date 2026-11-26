# Offloading

NOVA's second principle is to move as much work as possible out of the model. Native sessions do it
three ways: long tool results go to files, independent tool calls go in one batch, and the scripts
a successful run wrote are kept for reuse.
The measure that matters is tokens per completed goal.

## Long tool results go to files

Every native session wraps its tools with `withOffload` from `@generic-ai/tools`. A result whose text
is longer than 16,000 characters is written to an output file, and the model gets:

- the first 1,500 and the last 500 characters,
- how many characters were left out,
- the file path, with a pointer to read it in parts (`read` with `offset` and `limit`) or search it.

The file goes in the temp directory, named `generic-ai-<tool>-<16 hex>.txt` with mode `0600`, the
same as the shell tool's full-output files, so the workspace-confined `read` tool can open it and
other users cannot. Images in a result are kept. If the file cannot be written, the result is
returned unchanged. The tool's `details` gain `offloaded: { path, totalChars }`, and each offload
emits a `native.tool_result_offloaded` event.

```ts
await runCapabilityNativeAgentSession({
  // ...
  offload: { maxChars: 8000, headChars: 1000, tailChars: 300, exclude: ["read"] },
});
```

`offload: false` turns it off. The native tools already cap a result at 50 KB or 2,000 lines;
offloading cuts what the model sees further and keeps the rest one read away.

## Several tool calls in one step

`toolBatch: true` gives the agent `tool_batch`: up to 10 independent calls (`{ tool, arguments }`) run
together, with the results returned in one message under numbered headings. It saves a model turn
per call when the agent already knows what it needs, such as reading several files or running
several searches.

- Arguments are validated against each tool's schema, and each call runs through the tool's own
  `execute`, so policy and lifecycle hooks wrapped around the tool still apply.
- Tools marked sequential run one at a time after the others.
- A failing call is reported in its own section; the rest still run.
- `tool_batch` cannot call itself, `stop_and_respond`, `complete_goal` or `create_goal`; those stay
  single calls the session loop sees.
- Each result is offloaded as above, so a batch of long results stays short.

This is the safe part of programmatic tool calling: the agent composes several calls in one step
without the host running model-written code in-process. For multi-step work the agent writes a
script and runs it with `bash`, in the clean agent environment and, in the image, as the agent user.

## Harvesting scripts from successful runs

`harvest: { dir }` watches the files the agent writes with `write` and `edit`. Files ending in `.sh`,
`.bash`, `.py`, `.js`, `.mjs`, `.cjs` or `.ts`, or under a `scripts/` or `bin/` folder, count as
scripts (`isScript` changes that). When the run passes its goal's validators (`complete_goal`
accepted, or the autonomous gates pass), the session copies those scripts to `<dir>/<goal id>/` and
appends them to `<dir>/manifest.json` with the source path, SHA-256, goal, run and session. An
unchanged script is not saved twice for the same goal. A run that does not pass saves nothing. The
result's `harvestedScripts` lists what was saved, and a `native.scripts_harvested` event is emitted.

`promoteScriptToSkill` turns a saved script into a skill:

```ts
await promoteScriptToSkill({
  scriptPath: manifest.scripts[0].savedPath,
  skillsDir: "/data/skills",
  name: "count-lines",
  description: "Count the lines in a file.",
  flags: [{ name: "file", value: "PATH", description: "The file to count.", required: true }],
});
```

It writes `<skillsDir>/count-lines/SKILL.md` (name, description, a usage line such as
`bash scripts/count-lines.sh --file <PATH>`, and the flags) and copies the script to `scripts/`,
executable. Names follow the Agent Skills rules. An existing skill is kept unless `overwrite` is set.
Promotion is a host decision, not an agent tool, so an agent cannot install code into the skills
other agents load.
