# Fault-Injection Boundary Profile

This profile exercises `FaultInjectionSpec` as a benchmark contract for degraded
tool and memory boundaries. It is intentionally local and deterministic: the
profile proves that Generic AI can represent injected faults, expected
containment behavior, first violated contracts, and overclaim-prevention
evidence without importing plugin code into `@generic-ai/core`.

## Files

- [`mission.json`](mission.json): analysis mission for degraded dependency handling.
- [`benchmark.json`](benchmark.json): fault-injection cases, metrics, and validity gate.
- [`candidates/fault-aware-verifier.json`](candidates/fault-aware-verifier.json):
  verifier-loop fixture harness.
- [`sample-report.md`](sample-report.md): bounded interpretation example.

## Interpretation

This profile is a benchmark-coverage and evidence-quality improvement. It does
not establish a Terminal-Bench reward, success, or pass-rate delta. Plugin-owned
runtime injectors for live tool, retrieval, memory, web, MCP, messaging, and
storage faults should implement the SDK contract in follow-on work.
