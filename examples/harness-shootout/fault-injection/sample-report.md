# Fault-Injection Boundary Sample

This profile is a deterministic evidence-surface fixture, not an external
benchmark score claim.

## Planned Faults

- `tool-shell-timeout`: shell tool timeout at `tool.result.deadline`
- `memory-profile-stale-context`: stale memory read at `memory.provenance`

## Evidence Boundary

The benchmark report records planned case count, observed case count,
containment rate, recovery rate, overclaim-prevention rate, and the first
violated contracts. A report may use those fields to show that an agent handled
faults safely, but it must not claim a Terminal-Bench or external SOTA score
movement from this fixture alone.
