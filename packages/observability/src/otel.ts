import { getObservabilityMetricCatalog } from "./metrics.js";

export interface ObservabilityOtelMetricDescriptor {
  readonly name: string;
  readonly unit: string;
  readonly description: string;
  readonly attributes: readonly string[];
  readonly sourceEvents: readonly string[];
  readonly ownership: "observability_metrics_only";
}

export function createObservabilityOtelMetricDescriptors(): readonly ObservabilityOtelMetricDescriptor[] {
  return Object.freeze(
    getObservabilityMetricCatalog().map((metric) =>
      Object.freeze({
        name: metric.name,
        unit: metric.unit,
        description: metric.description,
        attributes: Object.freeze(metric.allowedAttributes.map((attribute) => attribute.name)),
        sourceEvents: metric.sourceEvents,
        ownership: "observability_metrics_only" as const,
      }),
    ),
  );
}

export const OBSERVABILITY_OTEL_EXPORT_ENDPOINT_STATUS = "deferred-by-adr-0029" as const;
