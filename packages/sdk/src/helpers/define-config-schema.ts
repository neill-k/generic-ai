import type { ConfigSchemaContract } from "../contracts/config-schema.js";

export function defineConfigSchema<TConfig>(
  schema: ConfigSchemaContract<TConfig>,
): ConfigSchemaContract<TConfig> {
  return schema;
}
