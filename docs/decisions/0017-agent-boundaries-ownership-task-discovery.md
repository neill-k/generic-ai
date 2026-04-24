# 0017 - Agent boundaries, ownership, and task discovery

- Status: accepted
- Date: 2026-04-24
- Linear: `NEI-382` (`CTL-01`, `CTL-03`)
- Supersedes: none
- Related:
  - `AGENTS.md`
  - `docs/ownership.md`
  - `.github/ISSUE_TEMPLATE/`
  - `.github/pull_request_template.md`

## Context

Generic AI is worked on by humans and coding agents. The repo already had planning docs and package boundaries, but it did not have a durable root instruction file, GitHub issue intake, PR template, or ownership guide on `main`.

## Decision

Add a root `AGENTS.md` that points agents to the planning pack, package boundaries, Node/npm baseline, and full verification gate.

Add GitHub issue forms for bugs and feature proposals. Linear remains the planned-work tracker, but GitHub issue forms provide structured external intake.

Add a PR template that makes verification and related tracker links explicit.

Add `docs/ownership.md` as the human-readable companion to `.github/CODEOWNERS`.

## Consequences

Agents have one repo-local instruction surface. Contributors have structured issue and PR paths. The ownership map can evolve from single-maintainer routing to path-specific teams without changing the surrounding process.

## Alternatives Considered

- Rely only on `CONTRIBUTING.md`. Rejected because agent instructions need a predictable root filename and a shorter execution-focused path.
- Keep GitHub issues disabled or blank. Rejected because external contributors need a structured intake path even when Linear remains the implementation tracker.
- Omit CODEOWNERS until there are multiple teams. Rejected because branch protection can require code-owner review today and the path map is useful documentation even with one owner.
