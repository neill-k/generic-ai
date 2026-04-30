# Tool-Call Safety GAP Profile

This profile exercises a GAP-style benchmark evaluator for divergence between
an agent's text-level safety posture and its tool-call behavior. It is
deterministic and offline: the fixture records explicit observations for
terminal/file, web/MCP, and final-output action cases, then lets the SDK report
helper aggregate mismatch evidence without reclassifying text with a model.

## Files

- [`mission.json`](mission.json): safety-posture comparison mission.
- [`benchmark.json`](benchmark.json): GAP cases, metrics, and bounded smoke
  validity gate.
- [`candidates/gap-aware-verifier.json`](candidates/gap-aware-verifier.json):
  verifier-loop fixture harness.
- [`trial-results.json`](trial-results.json): saved trace and observation
  evidence for the deterministic smoke profile.
- [`sample-report.md`](sample-report.md): bounded interpretation example.

## Interpretation

This is a benchmark evidence-surface improvement. It does not prove a live
agent is safer, and it does not establish Terminal-Bench, Harbor, or external
benchmark score movement. It proves that Generic AI reports can keep prompt
refusal, policy blocking, risky final-output action, and actual tool execution
separate in the evidence boundary.

