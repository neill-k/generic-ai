# Plan 05 — Research Harness Repositioning

Status: accepted
Owner: Generic AI maintainers
Depends on: planning pack 01–04, ADRs 0011, 0021, 0022, 0024, 0025, 0028, 0030
Source material: `docs/planning/research-harness-report.md` (deep-research input,
re-sourced for citations before any external use)

## 1. Why This Plan Exists

The first vertical slice of Generic AI is on `main`. The kernel, SDK, base
plugins, starter preset, Hono reference example, Docker sandbox, and the
agents-as-code harness spine (DSL → IR → runner → bounded report) all ship.

That puts the project at an inflection point. The question is no longer "can we
build a pluggable multi-agent framework" — that is done. The question is what
this repository is **for**, and how its public framing, package taxonomy,
benchmark stack, and runtime boundaries should be sharpened so the work already
in `main` reads as the category-defining product it is.

The deep-research input proposes a sharper definition:

> Generic AI is a composable agents-as-code research harness for specifying,
> running, tracing, evaluating, and comparing agentic system architectures under
> controlled conditions.

The repo already executes most of that definition. This plan converts the
remaining gap into concrete, sequenced work.

## 2. Position Statement (target framing)

Generic AI is the **lab bench for agentic architectures**. The reusable
primitive is a **harness configuration**: a declarative object that binds a
mission to a set of architectural choices, runtime constraints, evaluator
choices, and evidence requirements. The mission stays stable; the harness
varies. The output is evidence-backed comparison, not another way to ship an
agent.

Three corollaries follow:

1. The kernel does not privilege any topology. Hierarchy, squad, pipeline, and
   verifier-loop are method choices, not architectural commitments.
2. Plugins are organized by **research slot**, not just capability. A planner is
   a planner whether it ships ReAct, Plan-and-Solve, or Reflexion. A
   coordination module is a coordination module whether it ships hierarchy,
   debate, or critic-replan.
3. Reports are bounded by evidence. `insufficient_evidence` is a first-class
   outcome, not a failure mode.

## 3. Gap Analysis

| Area | Current state on `main` | Gap to the target framing |
| --- | --- | --- |
| Harness DSL → IR → benchmark runner | Shipped (ADR 0021/0022, `compileHarnessDsl`, `runHarnessBenchmark`) | Stable, but the public surface still reads as "framework with a benchmark feature" rather than "research harness." |
| Mission/harness separation | Shipped (`examples/harness-shootout/` has 1 mission × 4 candidate harnesses) | Only one mission family in the repo. Needs at least two more to validate cross-mission slot stability. |
| Plugin taxonomy | Capability-named (`tools-terminal`, `memory-files`, `mcp`) | No slot-named packages or registry. The research story is invisible to `npm search`. |
| Runtime boundary | Pi-direct only (ADR 0011 in flight) | No story for cross-runtime comparison. Either commit to pi-only forever (ADR) or open the door for additional adapters. |
| Trial reliability | Single-trial benchmark runs supported; multi-trial possible but not first-class | No `pass^k`-style metric in the canonical event schema or report renderers. |
| Effect descriptors | Authority covered (ADR 0024, PolicySpec, CapabilityGrant) | Reversibility not modeled. Recovery and rollback are evaluated only by outcome. |
| Observability | OTEL baseline + `@generic-ai/observability` (ADR 0030) | Trace schema is OTEL-shaped; no PROV-style provenance bundle for evidence semantics. |
| Benchmark stack | Macro only (Terminal-Bench Harbor) | No micro (function-calling, retrieval) or meso (browsing, τ-bench-style policy + tools) layer. |
| README and docs framing | "Pluggable, extensible multi-agent framework" | Buries the research-harness story under framework-construction language. |
| ADR hygiene | 30 ADRs, two duplicate numbers (0004, 0005) | Cosmetic, but worth fixing before the next ADR. |

## 4. Workstreams

The plan is organized into seven workstreams. Each is independently shippable
and ordered roughly by leverage-per-effort.

### W1 — Public framing (README, planning pack, docs)

**Goal:** the first paragraph a new reader sees matches the target position
statement.

- W1.1 Rewrite `README.md` lead so the first sentence is the sharpened
  definition. Reorder the top-of-README so the six first-class surfaces —
  Harness DSL, Generic Agent IR, runtime adapters, method plugins, benchmark
  suites, evidence reports — appear before the "shipped packages" inventory.
- W1.2 Add a "Why a research harness" section linking to ADR 0021, ADR 0022,
  and `examples/harness-shootout`.
- W1.3 Promote `examples/harness-shootout/sample-report.md` to a top-level
  callout in the README. It is the canonical product demo; treat it like one.
- W1.4 Update `docs/planning/01-scope-and-decisions.md` to reflect the
  repositioning. Architecture Lab stays a flagship demo, not the platform
  boundary, but the planning pack should say "research harness" where it
  currently says "framework."
- W1.5 Renumber duplicate ADRs (0004 config-contracts vs sdk-contracts; 0005
  plugin-host vs starter-preset). Add cross-references so existing links don't
  rot.

**Acceptance:** `npm run docs:check` passes; the README opens with the new
definition; `docs/planning/README.md` points at this plan as the active
direction.

### W2 — Slot taxonomy for plugins

**Goal:** plugins are discoverable and composable as **research slots**, not
just capabilities.

- W2.1 Define the slot vocabulary in an ADR (proposed: `0031-research-slots`).
  Slots: `planning`, `coordination`, `memory`, `communication`, `tool-policy`,
  `recovery`, `evaluation`, `reporting`, plus the existing infra/transport
  categories which stay capability-named.
- W2.2 Add a `genericAi.slot` field to the package manifest (or a registry
  document) so every publishable plugin declares its slot and the method family
  it implements (e.g., `slot: planning`, `method: react.v1`).
- W2.3 Build a slot registry doc at `docs/slots.md` that lists every shipped
  plugin by slot, with the method family and the canonical mission/harness it
  appears in.
- W2.4 Decide on package renaming. Options:
  - **Option A (low-risk):** keep current names, add slot tags + registry doc.
  - **Option B (higher-signal):** publish slot-aliased re-export packages
    (e.g., `@generic-ai/plugin-memory-files-temporal-episodic` re-exports
    `@generic-ai/plugin-memory-files`) so `npm search @generic-ai/plugin-planning-*`
    works.
  - **Option C (breaking):** rename outright. Not recommended pre-1.0 unless
    the registry option proves insufficient.
  Default recommendation: **A now, B at v0.3, C only if required.**
- W2.5 Backfill slot tags for every existing plugin and the starter preset.

**Acceptance:** every shipped plugin declares a slot; `docs/slots.md` is
generated or hand-maintained and linked from the README; the harness shootout
candidates reference slots by name.

### W3 — Effect descriptors: add reversibility

**Goal:** every method emits both **authority** and **reversibility**
metadata, so evaluators can score graceful failure and recovery, not just
final accuracy.

- W3.1 ADR (proposed: `0032-reversibility-effect-descriptor`) defining
  reversibility as a first-class dimension alongside authority. Levels:
  `irreversible`, `reversible-with-cost`, `reversible-cheap`, plus
  supersession and retry semantics.
- W3.2 Extend `CapabilityGrant` / effect descriptor schema in
  `@generic-ai/sdk` with a `reversibility` field. Default to `irreversible`
  for safety; force plugins to opt into weaker claims.
- W3.3 Update plugin-tools-terminal, plugin-tools-files, plugin-tools-web,
  plugin-memory-files, plugin-messaging to declare reversibility on their
  effect descriptors.
- W3.4 Extend the canonical event schema (ADR 0025) so emitted effect events
  include reversibility, and so recovery/rollback steps emit a paired
  `supersedes` reference.
- W3.5 Update report renderers to surface reversibility in the evidence
  bundle.

**Acceptance:** sandbox + file + memory plugins all declare reversibility;
canonical event schema v0.2 lands; `examples/harness-shootout/sample-report.md`
includes a reversibility column.

### W4 — Trial reliability and pass^k

**Goal:** repeated trials are first-class; one lucky run is never a result.

- W4.1 Add `trials: N` to BenchmarkSpec as a required field for any spec that
  wants a confident recommendation. Single-trial runs are allowed only for
  smoke checks and must be tagged as such in the report.
- W4.2 Implement `pass^k` reliability metric in the report renderer. Define
  it explicitly in `docs/harness-dsl.md` and the BenchmarkSpec schema.
- W4.3 Add seed and replay-id propagation to the canonical event schema so
  trial-to-trial variation is inspectable.
- W4.4 Add a `report.confidence` block that distinguishes
  `confident_recommendation`, `bounded_recommendation`, and
  `insufficient_evidence` — with an explicit rule that
  `trials < spec.minTrials` always yields `insufficient_evidence`.
- W4.5 Update the harness-shootout fixture to run ≥ 5 trials per candidate
  and regenerate `sample-report.md`.

**Acceptance:** BenchmarkSpec validates `trials` and `minTrials`; the shootout
report emits pass^k; `insufficient_evidence` is reachable from the default
config.

### W5 — Multi-runtime story (decide and write the ADR)

**Goal:** resolve the runtime-boundary question explicitly. Either commit to
pi-only and document it, or open the door for adapters.

- W5.1 Workshop and finalize ADR 0011 (already in flight). Pick one:
  - **Path A — pi-only forever.** Document why: `pi` is a moving target,
    multi-runtime adapters multiply maintenance, and architectural diversity
    inside one runtime is sufficient research surface.
  - **Path B — pluggable runtime.** Define the runtime adapter contract in
    `@generic-ai/sdk`. Identify which engines are in scope (Agents SDK,
    LangGraph, CrewAI, Agent Framework). Mark this as a v0.4+ commitment, not
    v0.2.
- W5.2 Whichever path is chosen, the canonical event schema and run envelope
  must be runtime-portable so future adapters do not require a schema break.
  This is essentially already true; verify and document it.
- W5.3 If path B: write a stub adapter contract and one proof-of-concept
  adapter (Agents SDK is the cleanest target because its tracing model is
  closest to OTEL).

**Acceptance:** ADR 0011 lands with a clear decision; if path B, a
`@generic-ai/runtime-adapter-*` contract package exists in `packages/sdk`.

### W6 — Benchmark stack: micro and meso layers

**Goal:** Generic AI ships at least one benchmark adapter at each scale —
micro, meso, macro — so architecture decisions can be tested where they
actually differ.

- W6.1 Macro is shipped: `examples/terminal-bench` (Terminal-Bench Harbor).
  Document this explicitly as the macro layer.
- W6.2 Meso layer: pick one. Recommendation: **τ-bench-style policy +
  tools** because it stresses the tool-policy and recovery slots that are
  most under-evaluated today. Alternative: WebArena-style browsing.
- W6.3 Micro layer: function-calling and retrieval microbenchmarks.
  Recommendation: ship a minimal in-repo `@generic-ai/bench-tool-calling`
  that mirrors BFCL-style scenarios at the IR level (not a fork of BFCL).
- W6.4 Each benchmark adapter publishes as a separate package under
  `packages/bench-*` or `examples/bench-*` and integrates with the same
  BenchmarkSpec / report pipeline as the shootout.
- W6.5 Add a "Three-tier benchmark stack" section to `docs/harness-dsl.md`.

**Acceptance:** at least one micro and one meso benchmark adapter exist; each
emits canonical events; each produces a bounded report.

### W7 — Provenance and evidence semantics (PROV-style bundle)

**Goal:** traces become research artifacts. Pair OTel runtime telemetry with
PROV-style evidence semantics so reports cite their evidence by entity and
activity, not just by span.

- W7.1 ADR (proposed: `0033-prov-evidence-bundles`) describing how PROV-style
  entities, activities, agents, and derivations map onto the canonical event
  schema and the run envelope.
- W7.2 Extend `@generic-ai/observability` with a provenance bundle exporter
  that produces a JSON-LD or Turtle artifact alongside the OTEL trace.
- W7.3 Update the report renderer so every observation, inference, and
  recommendation cites a provenance entity-id, not just a span-id.
- W7.4 Document the dual model: OTel for runtime causality, PROV for evidence
  semantics.

**Acceptance:** every shootout run produces a provenance bundle; the sample
report cites entities by id; `npm run docs:check` passes.

## 5. Sequencing

Three milestones, each shippable on its own.

### Milestone A — Reposition (target: 2 weeks)

- W1 (framing) — full
- W2.1, W2.2, W2.5 (slot taxonomy: ADR + tags + backfill, defer registry
  doc + renaming options)
- W4.1, W4.2, W4.4 (trials, pass^k, confidence block)
- W5.1 (ADR 0011 decision)
- ADR renumbering (W1.5)

This milestone closes the gap between repo reality and public framing without
any breaking change. It is mostly docs, schema additions, and one ADR decision.

### Milestone B — Sharpen (target: 4–6 weeks after A)

- W2.3, W2.4 Option A (slot registry doc; keep current package names)
- W3 (reversibility) — full
- W4.3, W4.5 (seed/replay, regenerated shootout report)
- W6.1, W6.2 (macro doc, one meso benchmark adapter)
- W7.1, W7.2 (provenance ADR + exporter)

This milestone makes the research story navigable and adds the most-missing
evaluation primitives (reversibility, repeated trials, meso benchmark).

### Milestone C — Extend (target: opportunistic, 8+ weeks)

- W2.4 Option B (slot-aliased re-export packages) if registry proves
  insufficient
- W5.2, W5.3 if ADR 0011 lands as path B
- W6.3 (micro benchmark adapter)
- W7.3, W7.4 (full PROV citations in reports)

This milestone is the long-tail expansion. Any of these can ship independently
once milestone B is settled.

## 6. Non-Goals

This plan does not commit to:

- Forking or replacing `pi`.
- Building a low-code agent builder or visual canvas beyond the existing
  console.
- Adopting Postgres storage or external queueing on this plan's timeline. Those
  remain `DEF-02` / `DEF-03` and are unblocked by this plan but not scheduled by
  it.
- Privileging any single coordination topology, memory model, or planner family
  in the kernel.
- Shipping runtime adapters for Agents SDK / LangGraph / CrewAI / Agent
  Framework before ADR 0011 lands its decision.

## 7. Risks

- **Renaming or aliasing plugin packages risks ecosystem churn.** Mitigation:
  default to slot tags + registry (Option A), defer Option B, never break
  imports without a major version.
- **PROV bundle adds artifact size and complexity.** Mitigation: make the
  exporter optional; OTel remains the primary trace. PROV is for evidence-grade
  reports.
- **Multi-runtime adapters are a long-tail commitment.** Mitigation: ADR 0011
  must explicitly choose path A or path B; do not drift.
- **`pass^k` and `trials` could break existing BenchmarkSpec consumers.**
  Mitigation: `trials` defaults to 1 with a deprecation warning; `minTrials`
  defaults to 1 in the same release; the breaking flip happens at v1.0.
- **Slot taxonomy is opinionated and could fight existing capability framing.**
  Mitigation: slots are additive metadata, not a renaming. Infra and transport
  plugins are explicitly outside the slot vocabulary.

## 8. Success Criteria (rolled up)

The plan is successful when, on `main`:

1. The README's first sentence matches the target position statement.
2. Every shipped plugin declares a research slot and method family.
3. Every effect descriptor declares both authority and reversibility.
4. BenchmarkSpec requires `trials` and emits `pass^k`; single-trial runs are
   tagged smoke-only and cannot produce a confident recommendation.
5. ADR 0011 is final; the runtime-boundary story is documented.
6. At least one micro, one meso, and one macro benchmark adapter exist.
7. Every shootout run emits both an OTel trace and a provenance bundle, and the
   sample report cites evidence by entity-id.
8. ADR numbering is unique; `docs/slots.md` exists and is linked from the
   README.

## 9. Open Questions

- Slot vocabulary: should `evaluation` and `reporting` be one slot or two?
  Current draft keeps them separate; revisit if no real plugin diversity
  emerges.
- Should the slot tag live in `package.json` (`genericAi.slot`) or in a central
  registry file? Decide in W2.1.
- For W6.2, τ-bench-style vs WebArena-style — which mission family better
  exercises the slots Generic AI is best at differentiating? Decide before W6
  starts.
- Path A vs path B on runtime adapters (W5.1) is the most consequential
  decision in the plan and should be made early in milestone A.

## 10. Appendices

- A — Source material: `docs/planning/research-harness-report.md` (the
  deep-research input that prompted this plan; citations are unverified tokens
  and must be re-sourced before any external use).
- B — Related ADRs: 0011 (pi direct boundary), 0021 (harness spine), 0022
  (composable harness control plane), 0024 (capability effect descriptors), 0025
  (canonical harness event schema), 0028 (web UI plugin), 0030 (observability
  surface).
- C — Existing harness shootout fixture: `examples/harness-shootout/`.
