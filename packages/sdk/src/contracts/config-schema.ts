import type { JsonObject } from "./shared.js";

export interface ConfigSchemaContract<TConfig = unknown> {
  readonly kind: "config-schema";
  readonly id: string;
  readonly description?: string;
  readonly version?: string;
  readonly schema: JsonObject;
  readonly defaults?: Partial<TConfig>;
  parse(input: unknown): TConfig;
  merge?(base: TConfig, next: Partial<TConfig>): TConfig;
}

export interface ConfigSchemaFragment {
  readonly path: string;
  readonly schema: JsonObject;
}

