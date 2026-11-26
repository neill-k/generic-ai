import type { Tool, ToolCall } from "./types.js";

/**
 * A small JSON Schema validator with argument coercion, written for tool-call arguments.
 *
 * Models often send `"42"` for a number, a single value for an array, or `null` for an omitted
 * optional property. {@link validateToolArguments} coerces such values before validating, following
 * the conversion rules TypeBox uses. It never generates code, so it runs where `eval` is disallowed.
 *
 * Supported keywords: type, enum, const, properties, required, additionalProperties, items,
 * prefixItems, anyOf, oneOf, allOf, not, $ref (local), minimum, maximum, exclusiveMinimum,
 * exclusiveMaximum, multipleOf, minLength, maxLength, pattern, minItems, maxItems, uniqueItems,
 * minProperties, maxProperties, nullable.
 */

type Schema = Record<string, unknown> | boolean;

interface ValidationError {
  readonly path: string[];
  readonly message: string;
}

const TYPE_PRIORITY = [
  "number",
  "integer",
  "boolean",
  "null",
  "string",
  "array",
  "object",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return true;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

class SchemaValidator {
  constructor(private readonly root: Schema) {}

  resolve(schema: Schema): Schema {
    let current = schema;
    const seen = new Set<string>();
    while (isRecord(current) && typeof current["$ref"] === "string") {
      const ref = current["$ref"];
      if (seen.has(ref)) {
        return true;
      }
      seen.add(ref);
      const target = this.lookup(ref);
      if (target === undefined) {
        // An unresolved reference rejects only the value at its place.
        return false;
      }
      const { $ref: _ignored, ...rest } = current;
      current = Object.keys(rest).length > 0 && isRecord(target) ? { ...target, ...rest } : target;
    }
    return current;
  }

  private lookup(ref: string): Schema | undefined {
    if (!ref.startsWith("#")) {
      return undefined;
    }
    const pointer = ref.slice(1);
    if (pointer === "" || pointer === "/") {
      return this.root;
    }
    let current: unknown = this.root;
    for (const raw of pointer.slice(1).split("/")) {
      const segment = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isRecord(current) && !Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === "boolean" || isRecord(current) ? current : undefined;
  }

  private types(schema: Record<string, unknown>): string[] | undefined {
    const type = schema["type"];
    const types =
      typeof type === "string" ? [type] : Array.isArray(type) ? (type as string[]) : undefined;
    if (types && schema["nullable"] === true && !types.includes("null")) {
      return [...types, "null"];
    }
    return types;
  }

  acceptsNull(input: Schema): boolean {
    return this.errors(input, null, []).length === 0;
  }

  // ---------------------------------------------------------------- coercion

  coerce(input: Schema, value: unknown): unknown {
    const schema = this.resolve(input);
    if (typeof schema === "boolean") {
      return value;
    }
    for (const key of ["anyOf", "oneOf"] as const) {
      const arms = schema[key];
      if (Array.isArray(arms)) {
        const base = this.withoutKey(schema, key);
        if (arms.some((arm) => this.isValid(this.merge(base, arm as Schema), value))) {
          return this.coerceShape(base, value);
        }
        for (const arm of arms) {
          const candidate = this.coerce(this.merge(base, arm as Schema), value);
          if (this.isValid(this.merge(base, arm as Schema), candidate)) {
            return candidate;
          }
        }
        return value;
      }
    }
    if (Array.isArray(schema["allOf"])) {
      let current = this.coerceShape(this.withoutKey(schema, "allOf"), value);
      for (const part of schema["allOf"] as Schema[]) {
        current = this.coerce(part, current);
      }
      return current;
    }
    return this.coerceShape(schema, value);
  }

  private withoutKey(schema: Record<string, unknown>, key: string): Record<string, unknown> {
    const { [key]: _removed, ...rest } = schema;
    return rest;
  }

  private merge(base: Record<string, unknown>, arm: Schema): Schema {
    if (typeof arm === "boolean" || Object.keys(base).length === 0) {
      return arm;
    }
    return { ...base, ...arm };
  }

  private coerceShape(schema: Record<string, unknown>, value: unknown): unknown {
    const types = this.types(schema);
    let current = value;
    if (types && !types.some((type) => matchesType(type, current))) {
      const ordered = TYPE_PRIORITY.filter((type) => types.includes(type));
      for (const type of ordered) {
        const converted = convertScalar(type, current);
        if (converted.ok) {
          current = converted.value;
          break;
        }
      }
    }
    if (schema["const"] !== undefined && !deepEqual(current, schema["const"])) {
      const converted = convertScalar(typeOf(schema["const"]), current);
      if (converted.ok && deepEqual(converted.value, schema["const"])) {
        current = converted.value;
      }
    }
    if (Array.isArray(schema["enum"]) && !schema["enum"].some((item) => deepEqual(item, current))) {
      for (const item of schema["enum"] as unknown[]) {
        const converted = convertScalar(typeOf(item), current);
        if (converted.ok && deepEqual(converted.value, item)) {
          current = converted.value;
          break;
        }
      }
    }
    if (Array.isArray(current)) {
      const prefix = Array.isArray(schema["prefixItems"])
        ? (schema["prefixItems"] as Schema[])
        : [];
      const items = schema["items"] as Schema | Schema[] | undefined;
      current = current.map((item, index) => {
        const itemSchema =
          prefix[index] ??
          (Array.isArray(items) ? items[index] : items) ??
          (undefined as Schema | undefined);
        return itemSchema === undefined ? item : this.coerce(itemSchema, item);
      });
    } else if (isRecord(current)) {
      const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
      const required = new Set(
        Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [],
      );
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        const propertySchema = properties[key] as Schema | undefined;
        if (propertySchema === undefined) {
          const additional = schema["additionalProperties"];
          next[key] = isRecord(additional) ? this.coerce(additional, item) : item;
          continue;
        }
        if (item === null && !required.has(key) && !this.acceptsNull(propertySchema)) {
          // Models send null for "not provided".
          continue;
        }
        next[key] = this.coerce(propertySchema, item);
      }
      current = next;
    }
    return current;
  }

  // -------------------------------------------------------------- validation

  isValid(schema: Schema, value: unknown): boolean {
    return this.errors(schema, value, []).length === 0;
  }

  errors(input: Schema, value: unknown, path: string[]): ValidationError[] {
    const schema = this.resolve(input);
    if (schema === true) {
      return [];
    }
    if (schema === false) {
      return [{ path, message: "not allowed" }];
    }
    const errors: ValidationError[] = [];
    const types = this.types(schema);
    if (types && !types.some((type) => matchesType(type, value))) {
      const got =
        value === undefined ? "undefined" : typeOf(value) === "integer" ? "number" : typeOf(value);
      return [{ path, message: `expected ${types.join(" or ")}, got ${got}` }];
    }
    if (schema["const"] !== undefined && !deepEqual(value, schema["const"])) {
      errors.push({ path, message: `expected ${JSON.stringify(schema["const"])}` });
    }
    if (Array.isArray(schema["enum"]) && !schema["enum"].some((item) => deepEqual(item, value))) {
      errors.push({
        path,
        message: `expected one of ${(schema["enum"] as unknown[]).map((item) => JSON.stringify(item)).join(", ")}`,
      });
    }
    if (Array.isArray(schema["anyOf"])) {
      const arms = schema["anyOf"] as Schema[];
      if (!arms.some((arm) => this.isValid(arm, value))) {
        errors.push({ path, message: "does not match any allowed schema" });
      }
    }
    if (Array.isArray(schema["oneOf"])) {
      const matches = (schema["oneOf"] as Schema[]).filter((arm) =>
        this.isValid(arm, value),
      ).length;
      if (matches !== 1) {
        errors.push({
          path,
          message:
            matches === 0 ? "does not match any allowed schema" : "matches more than one schema",
        });
      }
    }
    if (Array.isArray(schema["allOf"])) {
      for (const part of schema["allOf"] as Schema[]) {
        errors.push(...this.errors(part, value, path));
      }
    }
    if (schema["not"] !== undefined && this.isValid(schema["not"] as Schema, value)) {
      errors.push({ path, message: "matches a forbidden schema" });
    }
    if (typeof value === "number") {
      this.numberErrors(schema, value, path, errors);
    } else if (typeof value === "string") {
      this.stringErrors(schema, value, path, errors);
    } else if (Array.isArray(value)) {
      this.arrayErrors(schema, value, path, errors);
    } else if (isRecord(value)) {
      this.objectErrors(schema, value, path, errors);
    }
    return errors;
  }

  private numberErrors(
    schema: Record<string, unknown>,
    value: number,
    path: string[],
    errors: ValidationError[],
  ): void {
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    const exclusiveMinimum = schema["exclusiveMinimum"];
    const exclusiveMaximum = schema["exclusiveMaximum"];
    const multipleOf = schema["multipleOf"];
    if (typeof minimum === "number" && value < minimum) {
      errors.push({ path, message: `must be >= ${minimum}` });
    }
    if (typeof maximum === "number" && value > maximum) {
      errors.push({ path, message: `must be <= ${maximum}` });
    }
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      errors.push({ path, message: `must be > ${exclusiveMinimum}` });
    }
    if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
      errors.push({ path, message: `must be < ${exclusiveMaximum}` });
    }
    if (typeof multipleOf === "number" && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        errors.push({ path, message: `must be a multiple of ${multipleOf}` });
      }
    }
  }

  private stringErrors(
    schema: Record<string, unknown>,
    value: string,
    path: string[],
    errors: ValidationError[],
  ): void {
    const length = [...value].length;
    const minLength = schema["minLength"];
    const maxLength = schema["maxLength"];
    const pattern = schema["pattern"];
    if (typeof minLength === "number" && length < minLength) {
      errors.push({ path, message: `must have at least ${minLength} characters` });
    }
    if (typeof maxLength === "number" && length > maxLength) {
      errors.push({ path, message: `must have at most ${maxLength} characters` });
    }
    if (typeof pattern === "string") {
      try {
        if (!new RegExp(pattern, "u").test(value)) {
          errors.push({ path, message: `must match pattern ${pattern}` });
        }
      } catch {
        // An invalid pattern in a third-party schema does not block the call.
      }
    }
  }

  private arrayErrors(
    schema: Record<string, unknown>,
    value: unknown[],
    path: string[],
    errors: ValidationError[],
  ): void {
    const minItems = schema["minItems"];
    const maxItems = schema["maxItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      errors.push({ path, message: `must have at least ${minItems} items` });
    }
    if (typeof maxItems === "number" && value.length > maxItems) {
      errors.push({ path, message: `must have at most ${maxItems} items` });
    }
    if (schema["uniqueItems"] === true) {
      for (let index = 1; index < value.length; index += 1) {
        if (value.slice(0, index).some((item) => deepEqual(item, value[index]))) {
          errors.push({ path, message: "items must be unique" });
          break;
        }
      }
    }
    const prefix = Array.isArray(schema["prefixItems"]) ? (schema["prefixItems"] as Schema[]) : [];
    const items = schema["items"] as Schema | Schema[] | undefined;
    value.forEach((item, index) => {
      const itemSchema = prefix[index] ?? (Array.isArray(items) ? items[index] : items);
      if (itemSchema !== undefined) {
        errors.push(...this.errors(itemSchema, item, [...path, String(index)]));
      }
    });
  }

  private objectErrors(
    schema: Record<string, unknown>,
    value: Record<string, unknown>,
    path: string[],
    errors: ValidationError[],
  ): void {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    for (const key of required) {
      if (!(key in value) || value[key] === undefined) {
        errors.push({ path: [...path, key], message: "missing" });
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue;
      }
      const propertySchema = properties[key] as Schema | undefined;
      if (propertySchema !== undefined) {
        errors.push(...this.errors(propertySchema, item, [...path, key]));
        continue;
      }
      const additional = schema["additionalProperties"];
      if (additional === false) {
        errors.push({ path: [...path, key], message: "unexpected property" });
      } else if (isRecord(additional)) {
        errors.push(...this.errors(additional, item, [...path, key]));
      }
    }
    const count = Object.keys(value).length;
    const minProperties = schema["minProperties"];
    const maxProperties = schema["maxProperties"];
    if (typeof minProperties === "number" && count < minProperties) {
      errors.push({ path, message: `must have at least ${minProperties} properties` });
    }
    if (typeof maxProperties === "number" && count > maxProperties) {
      errors.push({ path, message: `must have at most ${maxProperties} properties` });
    }
  }
}

type Converted = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const NUMERIC = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/;

function convertScalar(type: string, value: unknown): Converted {
  switch (type) {
    case "number":
    case "integer": {
      let number: number | undefined;
      if (typeof value === "number") {
        number = value;
      } else if (typeof value === "string" && NUMERIC.test(value)) {
        number = Number(value);
      } else if (typeof value === "boolean") {
        number = value ? 1 : 0;
      } else if (value === null) {
        number = 0;
      }
      if (number === undefined || !Number.isFinite(number)) {
        return { ok: false };
      }
      return { ok: true, value: type === "integer" ? Math.trunc(number) : number };
    }
    case "boolean":
      if (value === "true" || value === "1" || value === 1) {
        return { ok: true, value: true };
      }
      if (value === "false" || value === "0" || value === 0) {
        return { ok: true, value: false };
      }
      return { ok: false };
    case "string":
      if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return { ok: true, value: String(value) };
      }
      return { ok: false };
    case "null":
      if (value === "" || value === "null" || value === 0 || value === false) {
        return { ok: true, value: null };
      }
      return { ok: false };
    case "array":
      if (value === undefined) {
        return { ok: false };
      }
      return { ok: true, value: [value] };
    default:
      return { ok: false };
  }
}

const validatorCache = new WeakMap<object, SchemaValidator>();

function validatorFor(schema: object): SchemaValidator {
  let validator = validatorCache.get(schema);
  if (!validator) {
    validator = new SchemaValidator(schema as Schema);
    validatorCache.set(schema, validator);
  }
  return validator;
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? "root" : path.join(".");
}

/** Coerce and validate `value` against a JSON Schema. */
export function validateJsonSchema(
  schema: object,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; errors: { path: string; message: string }[] } {
  const validator = validatorFor(schema);
  const coerced = validator.coerce(schema as Schema, structuredClone(value));
  const errors = validator.errors(schema as Schema, coerced, []);
  if (errors.length === 0) {
    return { ok: true, value: coerced };
  }
  return {
    ok: false,
    errors: errors.map((error) => ({ path: formatPath(error.path), message: error.message })),
  };
}

/** Find the tool named by the call and validate its arguments. */
export function validateToolCall(tools: readonly Tool[], toolCall: ToolCall): unknown {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }
  return validateToolArguments(tool, toolCall);
}

/**
 * Validate (and coerce) tool-call arguments against the tool's JSON Schema. Returns a copy of the
 * arguments; throws an error that lists every problem and quotes the received arguments.
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
  if (toolCall.argumentsError) {
    throw new Error(`Invalid arguments for tool "${toolCall.name}": ${toolCall.argumentsError}`);
  }
  const result = validateJsonSchema(tool.parameters, toolCall.arguments);
  if (result.ok) {
    return result.value;
  }
  const lines = result.errors.map((error) => `  - ${error.path}: ${error.message}`).join("\n");
  throw new Error(
    `Validation failed for tool "${toolCall.name}":\n${lines}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
  );
}
