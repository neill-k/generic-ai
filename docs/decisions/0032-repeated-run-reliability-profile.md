# 0032. Repeated-Run Reliability Profile

## Status

Accepted.

## Context

ADR 0021 through ADR 0027 established the agents-as-code evidence harness,
compiled harness contracts, trace-backed reports, and the difference between
smoke evidence and recommendation-quality benchmark evidence. The next benchmark
slice needs to represent reliability without overclaiming from single runs or
average scores.

The Linear NEI-511 research references two current signals:

- [Towards a Science of AI Agent Reliability](https://arxiv.org/abs/2602.16666)
  frames reliability across consistency, robustness, predictability, and safety.
- [Beyond Accuracy: A Multi-Dimensional Framework for Evaluating Enterprise
  Agentic AI Systems](https://arxiv.org/abs/2511.14136) reports that single-run
  accuracy can substantially overstate multi-run consistency.

The existing BenchmarkSpec already models trial counts and recommendation
thresholds, but the report contract does not make pass@k, retry accounting,
skipped/excluded attempts, perturbation labels, or bounded failure severity
visible.

## Decision

Generic AI will add an optional SDK-level `BenchmarkReliabilityProfile` to
`BenchmarkSpec`. The profile is report evidence, not a separate benchmark runner
or a replacement for the primary metric.

The SDK report helper computes a `BenchmarkReliabilitySummary` per candidate
when the profile is present:

- scored, passed, failed, skipped, excluded, and retried trial counts;
- pass rate, pass@k, binary consistency, and variance;
- perturbation-label summaries;
- maximum and average bounded failure severity;
- warnings when scored trial counts are below the configured reliability
  threshold or when retries/skips/exclusions are present.

Trial outcomes stay optional so existing benchmark results remain source
compatible. When explicit outcomes are absent, the report helper infers pass/fail
from the configured success metric and threshold.

## Consequences

- Benchmark reports can show why two candidates with equal average primary
  scores differ in reliability.
- Failed, retried, skipped, and excluded attempts remain visible instead of
  disappearing from aggregate averages.
- Recommendation boundaries remain conservative: the reliability profile adds
  evidence and warnings, but the primary recommendation still depends on the
  BenchmarkSpec validity gates.
- External benchmark or Terminal-Bench score improvement claims still require
  same-profile before/after evidence.

## Alternatives Considered

- **Make reliability a new benchmark runner.** Rejected because the immediate
  need is an interpretation and evidence-surface contract that works with
  existing BenchmarkTrialResult objects.
- **Fold reliability into the primary recommendation.** Rejected for v0.1
  because changing winner selection would require a broader policy for combining
  average score, variance, pass@k, and severity.
- **Hide skipped and excluded attempts from summaries.** Rejected because
  reliability claims should expose setup failures, explicit exclusions, and retry
  behavior.
