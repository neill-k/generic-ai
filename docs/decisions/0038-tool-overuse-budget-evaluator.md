# 0038. Tool-Overuse Budget Evaluator

## Status

Accepted.

## Context

ADR 0021 through ADR 0027 established the agents-as-code evidence harness,
compiled harness contracts, trace-backed reports, and bounded benchmark
recommendations. ADR 0032 added repeated-run reliability, and ADR 0031 added
fault-injection evidence. The next benchmark slice needs to represent tool-use
discipline without conflating it with final task correctness.

Linear NEI-526 references three current signals:

- [The Tool-Overuse Illusion](https://arxiv.org/abs/2604.19749) reports that
  unnecessary tool use is common and can be reduced when tool efficiency is
  rewarded.
- Vercel AI Gateway observability tracks request metadata, tokens, latency, and
  spend, matching the production need to attribute tool/model cost by request.
- [The Amazing Agent Race](https://arxiv.org/abs/2604.10261) separates
  navigation, tool-use, and final answer metrics, reinforcing that final success
  hides distinct agent failure modes.

Generic AI already records metrics, trace events, and artifacts, but its report
contract does not represent whether a task required tools, merely allowed tools,
or should have been answered directly.

## Decision

Generic AI will add an optional SDK-level `BenchmarkToolUseProfile` to
`BenchmarkSpec`. The profile is report evidence, not a new runner and not a
replacement for the primary metric.

The profile declares required, optional, and wasteful tool-use cases with local
tool-call budgets and direct-answer eligibility. Trial results may attach
`ToolUseObservation` records that count actual calls, necessary calls,
unnecessary calls, avoided calls, budget violations, and optional cost/latency
metadata.

The SDK report helper computes `ToolUseReportSummary` values per candidate and
for the whole report. Reports render tool efficiency, unnecessary calls, avoided
direct-answer opportunities, budget violations, and optional cost/latency
evidence separately from the scorecard.

## Consequences

- Benchmark reports can show why two candidates with equal task success differ
  in tool discipline.
- Cost and latency metadata remain optional, so offline fixtures and imported
  benchmark adapters can still use the contract.
- Recommendation boundaries remain conservative: tool-use summaries add
  evidence and warnings, but the primary recommendation still depends on the
  configured metric and validity gates.
- Tool plugins only need to emit trace/observation metadata. They do not own
  report interpretation.

## Alternatives Considered

- **Fold tool efficiency into the primary metric.** Rejected because some
  benchmarks should keep final correctness as the winner criterion while
  surfacing tool discipline as a guardrail.
- **Make this part of model routing or prompt caching.** Rejected because those
  concerns decide model/provider choice and context assembly; tool-overuse
  evaluates task affordances against actual tool behavior.
- **Require provider cost and latency metadata.** Rejected because many local
  and imported benchmark fixtures do not have provider billing metadata.
