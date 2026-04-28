import { createElement, type ReactElement } from "react";
import type {
  ObservabilityMetricDefinition,
  ObservabilityReport,
  ObservabilityRunRecord,
  ObservabilityTraceRecord,
} from "./types.js";

export type {
  ObservabilityMetricDefinition,
  ObservabilityMetricPoint,
  ObservabilityReport,
  ObservabilityRunRecord,
  ObservabilityTraceRecord,
} from "./types.js";

export interface ObservabilityShellProps {
  readonly runs: readonly ObservabilityRunRecord[];
  readonly metrics: readonly ObservabilityMetricDefinition[];
  readonly selectedTrace?: ObservabilityTraceRecord;
  readonly report?: ObservabilityReport;
}

export interface ObservabilityShellModel {
  readonly totals: {
    readonly runCount: number;
    readonly activeRunCount: number;
    readonly failedRunCount: number;
    readonly metricCount: number;
  };
  readonly runs: readonly ObservabilityRunRecord[];
  readonly selectedTrace?: ObservabilityTraceRecord;
  readonly report?: ObservabilityReport;
}

export function createObservabilityShellModel(
  props: ObservabilityShellProps,
): ObservabilityShellModel {
  const model = {
    totals: {
      runCount: props.runs.length,
      activeRunCount: props.runs.filter((run) => run.active).length,
      failedRunCount: props.runs.filter((run) => run.status === "failed").length,
      metricCount: props.metrics.length,
    },
    runs: props.runs,
    ...(props.selectedTrace === undefined ? {} : { selectedTrace: props.selectedTrace }),
    ...(props.report === undefined ? {} : { report: props.report }),
  };
  return Object.freeze(model);
}

export function ObservabilityShell(props: ObservabilityShellProps): ReactElement {
  const model = createObservabilityShellModel(props);
  return createElement(
    "section",
    { className: "generic-ai-observability" },
    createElement(
      "div",
      { className: "generic-ai-observability__grid" },
      panel("Runs", String(model.totals.runCount)),
      panel("Active", String(model.totals.activeRunCount)),
      panel("Failed", String(model.totals.failedRunCount)),
      panel("Metrics", String(model.totals.metricCount)),
    ),
    createElement(
      "div",
      { className: "generic-ai-observability__panel" },
      createElement(
        "ul",
        null,
        ...model.runs.map((run) =>
          createElement(
            "li",
            { key: `${run.workspaceId}:${run.runId}` },
            `${run.runId} - ${run.status} - ${run.eventCount} events`,
          ),
        ),
      ),
    ),
  );
}

function panel(label: string, value: string): ReactElement {
  return createElement(
    "div",
    { className: "generic-ai-observability__panel" },
    createElement("div", { className: "generic-ai-observability__label" }, label),
    createElement("div", { className: "generic-ai-observability__value" }, value),
  );
}
