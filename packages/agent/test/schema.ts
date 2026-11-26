// Minimal JSON Schema builders for tests, standing in for pi-schema's `obj`/`str`/`arr`/`opt`.

type Schema = Record<string, unknown>;
const OPTIONAL = Symbol("optional");
type OptionalSchema = Schema & { [OPTIONAL]: true };

export function str(options: { description?: string } = {}): Schema {
  return { type: "string", ...options };
}

export function arr(items: Schema, options: Schema = {}): Schema {
  return { type: "array", items, ...options };
}

export function opt(schema: Schema): OptionalSchema {
  return { ...schema, [OPTIONAL]: true } as OptionalSchema;
}

export function obj(properties: Record<string, Schema>, options: { open?: boolean } = {}): Schema {
  const required = Object.entries(properties)
    .filter(([, schema]) => !(OPTIONAL in schema))
    .map(([name]) => name);
  return {
    type: "object",
    properties,
    required,
    ...(options.open ? {} : { additionalProperties: false }),
  };
}
