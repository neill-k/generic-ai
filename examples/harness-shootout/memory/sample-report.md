# Memory Benchmark Profile Sample

This profile is a deterministic evidence-surface fixture, not an external
memory benchmark score claim.

## Key Signal

Both candidates can keep final answers useful in this fixture, but the report
distinguishes memory-operation quality:

| Candidate | Answer correct rate | Memory quality | Retrieval misses | Stale fact uses | Forgotten leaks | Provenance coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `memory-disciplined-agent` | 1 | 1 | 0 | 0 | 0 | 1 |
| `memory-shortcut-agent` | 1 | 0.20833333333333334 | 1 | 2 | 1 | 0.16666666666666666 |

## Evidence Boundary

The profile covers local deterministic cases for retrieval, update handling,
stale-fact suppression, selective forgetting, provenance reporting, and
multi-session handoff. It improves benchmark coverage and report diagnostics,
but it does not establish MemoryAgentBench, LongMemEval, LoCoMo, MemBench,
Harbor, or Terminal-Bench score movement.
