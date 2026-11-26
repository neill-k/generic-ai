import type { GoalValidatorKind } from "../goals/types.js";
import { formatRate } from "./summarize.js";
import type { GoalEvalCheckScores, GoalEvalReport } from "./types.js";

const CHECK_LABELS: Readonly<Record<GoalValidatorKind, string>> = {
  numeric: "Numeric outcomes",
  rubric: "Rubric grades",
  trace: "Required actions",
  output_schema: "Output structure",
  check: "Host checks",
};

const CHECK_ORDER: readonly GoalValidatorKind[] = [
  "numeric",
  "rubric",
  "trace",
  "output_schema",
  "check",
];

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatNumber(value: number | null, digits = 0): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function checksLine(checks: GoalEvalCheckScores): string {
  const parts = CHECK_ORDER.flatMap((kind) => {
    const score = checks[kind];
    return score === undefined ? [] : [`${kind} ${score.passed}/${score.total}`];
  });
  return parts.length === 0 ? "none" : parts.join(", ");
}

/** Markdown for a goal eval report, for CI logs and pull request comments. */
export function renderGoalEvalMarkdown(report: GoalEvalReport): string {
  const lines: string[] = [
    `# Goal eval: ${report.title ?? report.suiteId}`,
    "",
    `Gate: **${report.gate.passed ? "PASSED" : "FAILED"}**. ${report.passed} of ${report.trials} attempts reached their goal (${formatRate(report.passRate)}).`,
    "",
  ];
  if (report.gate.reasons.length > 0) {
    lines.push(...report.gate.reasons.map((reason) => `- ${reason}`), "");
  }

  lines.push(
    "## Efficiency",
    "",
    `- Tokens per completed goal: ${formatNumber(report.efficiency.tokensPerCompletedGoal)}`,
    `- Cost per completed goal: ${
      report.efficiency.costPerCompletedGoalUsd === null
        ? "n/a"
        : `$${report.efficiency.costPerCompletedGoalUsd.toFixed(4)}`
    }`,
    `- Total tokens: ${report.efficiency.totalTokens}`,
    ...(report.efficiency.attemptsWithoutUsage > 0
      ? [`- Attempts without usage evidence: ${report.efficiency.attemptsWithoutUsage}`]
      : []),
    ...(report.efficiency.budgetStops > 0
      ? [`- Stopped by a budget cap: ${report.efficiency.budgetStops}`]
      : []),
    "",
    "## Checks",
    "",
    "| Check | Passed | Score |",
    "| --- | --- | --- |",
  );
  for (const kind of CHECK_ORDER) {
    const score = report.checks[kind];
    if (score !== undefined) {
      lines.push(
        `| ${CHECK_LABELS[kind]} | ${score.passed}/${score.total} | ${score.score.toFixed(2)} |`,
      );
    }
  }

  lines.push(
    "",
    "## Cases",
    "",
    "| Case | Passed | pass^k | Checks | Integrity | Tokens per goal |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const summary of report.cases) {
    lines.push(
      `| ${cell(summary.title ?? summary.caseId)} | ${summary.passed}/${summary.trials} | pass^${summary.passK.k} = ${summary.passK.value.toFixed(3)} | ${checksLine(summary.checks)} | ${summary.integrityViolations} | ${formatNumber(summary.efficiency.tokensPerCompletedGoal)} |`,
    );
  }

  if (report.findings.length > 0) {
    lines.push(
      "",
      "## Where to add complexity",
      "",
      "Checks that failed most often. Start here when changing prompts, tools, validators, or scripts.",
      "",
      "| Case | Check | Failed | Most common message |",
      "| --- | --- | --- | --- |",
    );
    for (const finding of report.findings.slice(0, 20)) {
      const message =
        finding.fix === undefined ? finding.message : `${finding.message} Fix: ${finding.fix}`;
      lines.push(
        `| ${cell(finding.caseId)} | ${cell(finding.validatorId)} | ${finding.failures}/${finding.trials} | ${cell(message)} |`,
      );
    }
  }

  const violations = report.results.flatMap((result) =>
    result.integrity.map((finding) => ({ result, finding })),
  );
  if (violations.length > 0) {
    lines.push("", "## Integrity violations", "");
    for (const { result, finding } of violations) {
      lines.push(`- ${result.caseId} / ${result.trialId}: \`${finding.code}\`. ${finding.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
