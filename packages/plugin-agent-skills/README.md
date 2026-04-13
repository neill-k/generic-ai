# @generic-ai/plugin-agent-skills

Agent Skills support plugin for Generic AI. Implements the public Agent Skills spec so agents can discover and load skills from the standard locations.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Implement Agent Skills compatibility against the public spec
- Scan the broad standard skill locations, including `.agents/skills/`
- Support progressive disclosure of skill contents to the agent
- Defer trust gating to a later version

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
