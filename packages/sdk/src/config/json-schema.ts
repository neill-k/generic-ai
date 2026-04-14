export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

export type JsonSchemaTypeName =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

export interface JsonSchema {
  $id?: string;
  $schema?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  const?: JsonValue;
  enum?: JsonValue[];
  default?: JsonValue;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  pattern?: string;
  minimum?: number;
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
}

export interface JsonSchemaEmitter<TSchema> {
  emit(schema: TSchema, targetId: string): JsonSchema;
}
