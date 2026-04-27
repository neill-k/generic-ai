# @generic-ai/plugin-repo-map

Deterministic compact repository map capability for Generic AI harness runs.

The plugin exposes a Pi-compatible `repo_map` tool and a direct `snapshot()` API. It is intended for planner and explorer roles that need fast orientation before more expensive terminal or LSP calls.

The tool declares `repo.inspect` and `fs.read` effects for `AgentHarness` role-policy filtering.
