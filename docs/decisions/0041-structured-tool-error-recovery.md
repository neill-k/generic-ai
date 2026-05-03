# 0041. Structured Tool-Error Recovery

## Context

Agent benchmark failures are often opaque. A tool can timeout, hit a provider
rate limit, require authentication, receive invalid input, be blocked by policy,
or exhaust a per-step budget. Before this decision, Generic AI reports could
show final task success, tool-use discipline, fault-injection containment, and
runtime diagnostics, but there was no shared contract for recovery semantics
attached to failed tool attempts.

NEI-532 asked for structured tool-error recovery and timeout budget contracts
without making the kernel own tool-specific behavior.

## Decision

Generic AI will add SDK-owned structured tool-error contracts:

- `ToolErrorEnvelope` for stable error kind, retryability, transient status,
  user-actionable status, redaction-safe message, local raw-cause metadata,
  remediation hints, and optional timeout budget metadata.
- `ToolTimeoutBudget` for total, spent, remaining, reserved, and exhausted
  budget fields.
- `BenchmarkSpec.toolRecovery` plus per-trial `toolRecovery` observations so
  benchmark reports can summarize failed, skipped, retried, and policy-blocked
  tool attempts separately from final task correctness.
- SDK helpers that convert native errors into normalized envelopes while
  preserving plugin-owned extension space.

Tool plugins own native error mapping. The kernel may carry normalized
observations in benchmark evidence, but it must not interpret provider-specific
status codes or decide recovery policy for individual tools.

## Consequences

- Reports can now distinguish timeout, budget exhaustion, policy blocking,
  invalid input, rate limits, authentication, not found, upstream unavailable,
  and unknown tool failures.
- Runtime and benchmark evidence can describe whether a failure was retryable,
  transient, or user-actionable without exposing raw provider output in the
  public report path.
- Existing tool plugins can adopt the envelope incrementally. The first slice
  maps terminal and web tool failures while keeping file, MCP, and sandbox
  plugin adoption as follow-on work.
- This is evidence infrastructure. It does not claim a Terminal-Bench or Harbor
  score improvement unless a same-profile before/after benchmark run measures
  reward, success, pass-rate, duration, or exception-rate movement.

## Alternatives Considered

- Put recovery categories directly in the kernel. Rejected because recovery is
  tool-specific and would collapse plugin boundaries.
- Treat tool errors as fault-injection observations. Rejected because
  fault-injection describes planned degraded cases, while runtime tool recovery
  also needs to represent unplanned native failures and retry outcomes.
- Leave errors as strings in traces. Rejected because benchmark reports and
  agents need machine-readable retryability, policy-blocked, timeout, and
  user-actionable distinctions.
