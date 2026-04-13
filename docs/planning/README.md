# Planning Pack

This directory is the authoritative planning baseline for the `Generic AI Framework` reimplementation.

Use this README plus the numbered planning docs below as the planning source of truth for scope, architecture, dependency order, and Linear synchronization.

## Source Of Truth Rules

- `README.md` is the repo entrypoint and points to this planning pack.
- `01` through `04` are the active planning baseline and should be kept consistent with each other.
- Notes or drafts elsewhere in the repo are not authoritative for reimplementation planning unless this pack links to them explicitly.
- When the plan changes, update this pack before or alongside any Linear issue changes that depend on it.

## Review Order

1. [01-scope-and-decisions.md](01-scope-and-decisions.md)
2. [02-architecture.md](02-architecture.md)
3. [03-linear-issue-tree.md](03-linear-issue-tree.md)
4. [04-agent-ready-mapping.md](04-agent-ready-mapping.md)

## Linear Import Order

If this planning tree needs to be recreated or resynced in Linear, import it in dependency order:

1. `FND-01` through `FND-04`
2. `KRN-01` through `KRN-09`
3. `CFG-01` through `CFG-04`
4. `INF-01` through `INF-06`
5. `CAP-01` through `CAP-07`
6. `TRN-01` through `TRN-03`
7. `CTL-01` through `CTL-07`
8. `DEF-01` through `DEF-06`

Within each group, preserve the written issue order and dependency links from `03-linear-issue-tree.md`.

## Planning Principles

- Favor a clean long-term public framework over the fastest possible first build.
- Keep the kernel minimal.
- Put useful agent capabilities into replaceable base plugins.
- Expose `pi` directly where practical instead of rewrapping every primitive.
- Make the starter preset the default path to a working multi-agent system.
- Map the roadmap to the `agent-ready` profile explicitly instead of claiming compliance abstractly.
