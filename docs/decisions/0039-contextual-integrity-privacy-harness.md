# 0039 Contextual-Integrity Privacy Harness

## Context

Workspace agents often need context from files, memory, messages, and connected
tools to be useful. The same context can become a privacy leak when it is sent
to the wrong recipient or used for the wrong purpose. Generic AI already has
SDK benchmark contracts, policy records, memory and messaging plugin
boundaries, and bounded report rendering. It needs a way to evaluate
contextual privacy flows without turning the kernel into a DLP engine.

Linear NEI-516 asks whether contextual-integrity checks should be authored as
benchmark graders, policy specs, or both.

## Decision

Add contextual-integrity privacy as an optional SDK benchmark profile and
report summary.

The SDK owns the reusable contract:

- actors involved in a flow
- data classes and sensitivity labels
- transmission principles binding sender, recipient, purpose, data classes,
  and expectation
- benchmark cases and trial observations
- report summaries for utility, leakage, required disclosure misses, and
  prohibited disclosure violations

For v0.1 this is primarily a benchmark grader/report surface. Policy specs can
reference the same vocabulary later, but runtime enforcement remains
plugin-owned and identity/auth remains on its separate roadmap.

## Consequences

- Benchmark fixtures can compare useful-but-over-disclosing candidates against
  privacy-preserving candidates under the same primary report pipeline.
- Reports can show privacy leakage separately from final task utility.
- Plugins remain responsible for live enforcement, approvals, identity, and
  storage-specific redaction.
- The contract is additive and optional, so existing BenchmarkSpec consumers
  continue to work.

## Alternatives Considered

### Put contextual integrity directly in PolicySpec

Rejected for this slice. PolicySpec is the eventual enforcement vocabulary, but
the immediate need is benchmark evidence and report aggregation. Starting in
PolicySpec would imply runtime enforcement that this issue does not ship.

### Implement a dedicated privacy plugin first

Rejected for this slice. A plugin will be useful once enforcement and live
adapters are ready, but the shared SDK profile lets benchmark examples and
future plugins agree on the evidence shape first.

### Treat privacy as only another metric

Rejected. Raw metrics can record leakage, but they do not preserve the
recipient, purpose, and data-class structure needed to explain contextual
integrity failures.
