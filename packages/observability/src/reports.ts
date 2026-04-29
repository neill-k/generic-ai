import type { ObservabilityReport, ObservabilityTraceRecord } from "./types.js";

export function createDeterministicObservabilityReport(
  trace: ObservabilityTraceRecord,
  options: { readonly generatedAt?: string } = {},
): ObservabilityReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const observations = [
    `Run ${trace.run.runId} is ${trace.run.status}.`,
    `Collected ${trace.events.length} events, ${trace.projections.length} projections, ${trace.artifacts.length} artifacts, and ${trace.policyDecisions.length} policy decisions.`,
  ];
  const inferences: string[] = [];
  const insufficientEvidence: string[] = [];

  if (trace.events.length === 0) {
    insufficientEvidence.push("No events were ingested for this run.");
  }

  if (trace.run.status === "failed") {
    inferences.push("The run ended in failure; inspect terminal tool, model, or policy evidence.");
  } else if (trace.run.status === "succeeded") {
    inferences.push("The run reached a terminal success state.");
  } else {
    insufficientEvidence.push("The run has not reached a terminal state.");
  }

  if (trace.policyDecisions.some((decision) => decision.decision === "denied")) {
    inferences.push("At least one policy decision denied an action.");
  }

  return Object.freeze({
    kind: "generic-ai.observability-report",
    generatedAt,
    workspaceId: trace.run.workspaceId,
    runId: trace.run.runId,
    status: trace.run.status,
    observations: Object.freeze(observations),
    inferences: Object.freeze(inferences),
    evidence: Object.freeze({
      eventCount: trace.events.length,
      metricCount: trace.run.metricCount,
      artifactCount: trace.artifacts.length,
      policyDecisionCount: trace.policyDecisions.length,
    }),
    insufficientEvidence: Object.freeze(insufficientEvidence),
  });
}

export function renderObservabilityReportMarkdown(report: ObservabilityReport): string {
  return [
    `# Observability Report: ${report.runId}`,
    "",
    `Workspace: ${report.workspaceId}`,
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    "",
    "## Observations",
    "",
    ...report.observations.map((item) => `- ${item}`),
    "",
    "## Inferences",
    "",
    ...(report.inferences.length > 0 ? report.inferences : ["No deterministic inference available."]).map(
      (item) => `- ${item}`,
    ),
    "",
    "## Evidence",
    "",
    `- Events: ${report.evidence.eventCount}`,
    `- Metrics: ${report.evidence.metricCount}`,
    `- Artifacts: ${report.evidence.artifactCount}`,
    `- Policy decisions: ${report.evidence.policyDecisionCount}`,
    "",
    ...(report.insufficientEvidence.length > 0
      ? ["## Insufficient Evidence", "", ...report.insufficientEvidence.map((item) => `- ${item}`), ""]
      : []),
  ].join("\n");
}
