# Harness DSL v0.1 Spec

Harness DSL is the Generic AI agents-as-code language. It describes an agent
system independently of any one application: packages, agents, capabilities,
spaces, relationships, protocols, policies, missions, evals, traces, artifacts,
and report expectations.

The DSL compiles into Generic Agent IR. The compiled IR is the stable runtime
contract; the source DSL can evolve with package-defined extensions.

## Object Model

The v0.1 top-level object is `generic-ai.harness`:

- `packages`: reusable packages the harness depends on.
- `capabilities`: package-contributed tools, policies, graders, memory, trace,
  report, protocol, or custom surfaces.
- `agents`: role/instruction/model declarations plus package and capability
  references.
- `spaces`: workspaces, message threads, memory stores, artifact stores, or
  scratch spaces.
- `relationships`: coordination edges between agents.
- `protocols`: protocol package bindings that plan work without executing side
  effects directly.
- `policies`: authority and capability rules.
- `artifacts`: required, produced, and reviewed outputs.
- `missionRefs` and `evalRefs`: links to reproducible missions and benchmarks.

## Compile Boundary

The compiler validates references and topology, then emits:

- compiled actors with invocation templates,
- package version maps,
- capability, protocol, policy, and artifact contracts,
- a deterministic capability BOM inventory and fingerprint,
- stable source and compiled fingerprints,
- deterministic diagnostics before runtime execution.

Runtime code consumes the compiled contract. It does not treat loose YAML or JSON
as executable authority.

## Evidence Boundary

MissionSpec and BenchmarkSpec are first-class platform objects. Reports must keep
observations, inferences, and recommendations separate. Underpowered runs or
incomplete traces produce `insufficient_evidence` rather than a winner claim.
Metric definitions may declare whether higher or lower values are better; report
recommendations must honor that direction and must not turn missing primary
metric samples into zero-valued evidence.

Benchmark reports may attach capability BOMs for each compiled candidate
harness. The BOM makes package, capability, protocol, policy, and artifact drift
visible as provenance evidence; it is not a trust approval or runtime permission
grant.

Repeated-run reliability metadata is report evidence, not a separate winner
oracle. Benchmark profiles may define success thresholds, pass@k cuts,
perturbation labels, and failure-severity sources so reports can show
consistency, variance, retries, skipped/excluded trials, and bounded failure
severity alongside average score.

## Package Extension Boundary

Packages may contribute schema fragments, capabilities, protocols, graders,
trace exporters, and report renderers. Package extension points must compile into
typed IR and cannot bypass policy or artifact obligations.

## Launch Fixture

The first public fixture lives in
[`examples/harness-shootout`](../../examples/harness-shootout). It declares one
coding mission, four package-composed candidates, a repeated-trial benchmark,
and a sample report.
