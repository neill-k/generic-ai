import { getObservabilityMetricCatalog } from "./metrics.js";
import { createDeterministicObservabilityReport } from "./reports.js";
import type {
  ObservabilityMetricQuery,
  ObservabilityRepository,
  ObservabilityRunListFilter,
} from "./types.js";

export interface ObservabilityAgentTools {
  readonly listRuns: (filter: ObservabilityRunListFilter) => Promise<unknown>;
  readonly getRun: (input: { readonly workspaceId: string; readonly runId: string }) => Promise<unknown>;
  readonly getTrace: (input: { readonly workspaceId: string; readonly runId: string }) => Promise<unknown>;
  readonly queryMetrics: (query: ObservabilityMetricQuery) => Promise<unknown>;
  readonly getMetricCatalog: () => Promise<unknown>;
  readonly createReport: (input: {
    readonly workspaceId: string;
    readonly runId: string;
  }) => Promise<unknown>;
}

export function createObservabilityAgentTools(
  repository: ObservabilityRepository,
): ObservabilityAgentTools {
  return Object.freeze({
    async listRuns(filter: ObservabilityRunListFilter) {
      return { runs: await repository.listRuns(filter) };
    },

    async getRun(input: { readonly workspaceId: string; readonly runId: string }) {
      return { run: await repository.getRun(input.workspaceId, input.runId) };
    },

    async getTrace(input: { readonly workspaceId: string; readonly runId: string }) {
      return { trace: await repository.getTrace(input.workspaceId, input.runId) };
    },

    async queryMetrics(query: ObservabilityMetricQuery) {
      return { metrics: await repository.queryMetrics(query) };
    },

    async getMetricCatalog() {
      return { metrics: getObservabilityMetricCatalog() };
    },

    async createReport(input: { readonly workspaceId: string; readonly runId: string }) {
      const trace = await repository.getTrace(input.workspaceId, input.runId);
      return { report: trace ? createDeterministicObservabilityReport(trace) : undefined };
    },
  });
}
