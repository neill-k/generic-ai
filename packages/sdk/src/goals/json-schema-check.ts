import type { JsonObject } from "../contracts/shared.js";

/**
 * A dependency-free checker for the JSON Schema subset that goal specs and
 * structured agent outputs use. It is intentionally small: the goal is
 * actionable error text an agent can fix, not full draft 2020-12 coverage.
 *
 * Supported keywords: `type`, `enum`, `const`, `properties`, `required`,
 * `additionalProperties`, `items`, `minItems`, `maxItems`, `uniqueItems`,
 * `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`,
 * `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minProperties`,
 * `anyOf`, `oneOf`, `allOf`, `not`, and local `$ref` into `#/$defs/...` or
 * `#/definitions/...`. Unknown keywords are ignored, as JSON Schema requires.
 */
export interface JsonSchemaIssue {
  /** JSONPath-style location of the offending value, rooted at `$`. */
  readonly path: string;
  readonly message: string;
}

export interface JsonSchemaCheckResult {
  readonly valid: boolean;
  readonly issues: readonly JsonSchemaIssue[];
}

export interface JsonSchemaCheckOptions {
  /** Stop collecting issues after this many. Defaults to 50. */
  readonly maxIssues?: number;
}

type SchemaNode = JsonObject | boolean;

interface CheckState {
  readonly root: SchemaNode;
  readonly issues: JsonSchemaIssue[];
  readonly maxIssues: number;
  depth: number;
}

const MAX_REF_DEPTH = 64;

export function checkAgainstJsonSchema(
  schema: JsonObject | boolean,
  value: unknown,
  options: JsonSchemaCheckOptions = {},
): JsonSchemaCheckResult {
  const state: CheckState = {
    root: schema,
    issues: [],
    maxIssues: options.maxIssues ?? 50,
    depth: 0,
  };
  checkNode(schema, value, "$", state);
  return Object.freeze({
    valid: state.issues.length === 0,
    issues: Object.freeze(state.issues.slice(0, state.maxIssues)),
  });
}

export function formatJsonSchemaIssues(issues: readonly JsonSchemaIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function report(state: CheckState, path: string, message: string): void {
  if (state.issues.length < state.maxIssues) {
    state.issues.push(Object.freeze({ path, message }));
  }
}

function childPath(path: string, key: string | number): string {
  if (typeof key === "number") {
    return `${path}[${key}]`;
  }
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function jsonTypeOf(value: unknown): string {
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

function matchesType(value: unknown, type: string): boolean {
  const actual = jsonTypeOf(value);
  if (type === "number") {
    return actual === "number" || actual === "integer";
  }
  return actual === type;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonDeepEqual(item, right[index]))
    );
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonDeepEqual(left[key], right[key]))
    );
  }
  return false;
}

function resolveRef(state: CheckState, ref: string): SchemaNode | undefined {
  if (!ref.startsWith("#")) {
    return undefined;
  }
  if (ref === "#") {
    return state.root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let node: unknown = state.root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = decodeURIComponent(rawSegment).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(node)) {
      return undefined;
    }
    node = node[segment];
  }
  return typeof node === "boolean" || isObject(node) ? (node as SchemaNode) : undefined;
}

function describe(value: unknown): string {
  const type = jsonTypeOf(value);
  if (type === "string") {
    const text = value as string;
    return `string ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text)}`;
  }
  if (type === "number" || type === "integer" || type === "boolean") {
    return `${type} ${String(value)}`;
  }
  return type;
}

/** Runs `checkNode` against a scratch issue list and reports whether it passed. */
function trial(
  schema: SchemaNode,
  value: unknown,
  path: string,
  state: CheckState,
): JsonSchemaIssue[] {
  const scratch: CheckState = {
    root: state.root,
    issues: [],
    maxIssues: state.maxIssues,
    depth: state.depth,
  };
  checkNode(schema, value, path, scratch);
  return scratch.issues;
}

/**
 * For `anyOf`/`oneOf` branches that discriminate on `properties.kind.const`
 * (or any single const property), pick the branch whose const matches so the
 * reported errors describe the branch the author meant.
 */
function deref(node: unknown, state: CheckState): unknown {
  let current = node;
  for (let hops = 0; hops < MAX_REF_DEPTH && isObject(current); hops += 1) {
    const ref = current["$ref"];
    if (typeof ref !== "string") {
      break;
    }
    current = resolveRef(state, ref);
  }
  return current;
}

function discriminatedBranch(
  rawBranches: readonly unknown[],
  value: unknown,
  state: CheckState,
): SchemaNode | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const branches = rawBranches.map((branch) => deref(branch, state));
  for (const branch of branches) {
    if (!isObject(branch) || !isObject(branch["properties"])) {
      continue;
    }
    const properties = branch["properties"] as Record<string, unknown>;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (
        isObject(propertySchema) &&
        Object.hasOwn(propertySchema, "const") &&
        Object.hasOwn(value, key) &&
        jsonDeepEqual(propertySchema["const"], value[key])
      ) {
        return branch as JsonObject;
      }
    }
  }
  return undefined;
}

function discriminatorValues(
  rawBranches: readonly unknown[],
  state: CheckState,
): { key: string; values: unknown[] } | undefined {
  const branches = rawBranches.map((branch) => deref(branch, state));
  let key: string | undefined;
  const values: unknown[] = [];
  for (const branch of branches) {
    if (!isObject(branch) || !isObject(branch["properties"])) {
      return undefined;
    }
    const entry = Object.entries(branch["properties"] as Record<string, unknown>).find(
      ([, propertySchema]) => isObject(propertySchema) && Object.hasOwn(propertySchema, "const"),
    );
    if (entry === undefined || (key !== undefined && entry[0] !== key)) {
      return undefined;
    }
    key = entry[0];
    values.push((entry[1] as Record<string, unknown>)["const"]);
  }
  return key === undefined ? undefined : { key, values };
}

function checkNode(schema: SchemaNode, value: unknown, path: string, state: CheckState): void {
  if (schema === true) {
    return;
  }
  if (schema === false) {
    report(state, path, "no value is allowed here");
    return;
  }

  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const target = resolveRef(state, ref);
    if (target === undefined) {
      report(state, path, `schema reference ${ref} could not be resolved`);
      return;
    }
    if (state.depth >= MAX_REF_DEPTH) {
      report(state, path, "schema references nest too deeply");
      return;
    }
    state.depth += 1;
    checkNode(target, value, path, state);
    state.depth -= 1;
  }

  const type = schema["type"];
  if (typeof type === "string" || Array.isArray(type)) {
    const allowed = (Array.isArray(type) ? type : [type]).filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (!allowed.some((entry) => matchesType(value, entry))) {
      report(state, path, `expected ${allowed.join(" or ")}, got ${describe(value)}`);
      return;
    }
  }

  if (Object.hasOwn(schema, "const") && !jsonDeepEqual(schema["const"], value)) {
    report(state, path, `must equal ${JSON.stringify(schema["const"])}, got ${describe(value)}`);
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((entry) => jsonDeepEqual(entry, value))) {
    report(
      state,
      path,
      `must be one of ${enumValues.map((entry) => JSON.stringify(entry)).join(", ")}, got ${describe(value)}`,
    );
  }

  if (typeof value === "string") {
    checkString(schema, value, path, state);
  }
  if (typeof value === "number") {
    checkNumber(schema, value, path, state);
  }
  if (Array.isArray(value)) {
    checkArray(schema, value, path, state);
  }
  if (isObject(value)) {
    checkObject(schema, value, path, state);
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      if (typeof branch === "boolean" || isObject(branch)) {
        checkNode(branch as SchemaNode, value, path, state);
      }
    }
  }

  checkCombinator(schema, "anyOf", value, path, state);
  checkCombinator(schema, "oneOf", value, path, state);

  const not = schema["not"];
  if (
    (typeof not === "boolean" || isObject(not)) &&
    trial(not as SchemaNode, value, path, state).length === 0
  ) {
    report(state, path, "must not match the excluded schema");
  }
}

function checkCombinator(
  schema: JsonObject,
  keyword: "anyOf" | "oneOf",
  value: unknown,
  path: string,
  state: CheckState,
): void {
  const raw = schema[keyword];
  if (!Array.isArray(raw)) {
    return;
  }
  const branches = raw.filter(
    (branch) => typeof branch === "boolean" || isObject(branch),
  ) as SchemaNode[];
  const results = branches.map((branch) => trial(branch, value, path, state));
  const passing = results.filter((issues) => issues.length === 0).length;

  if (keyword === "oneOf" && passing > 1) {
    report(state, path, `must match exactly one allowed shape, but matched ${passing}`);
    return;
  }
  if (passing >= 1) {
    return;
  }

  const chosen = discriminatedBranch(branches, value, state);
  if (chosen !== undefined) {
    checkNode(chosen, value, path, state);
    return;
  }

  const discriminator = discriminatorValues(branches, state);
  if (discriminator !== undefined && isObject(value)) {
    report(
      state,
      childPath(path, discriminator.key),
      `must be one of ${discriminator.values.map((entry) => JSON.stringify(entry)).join(", ")}, got ${
        Object.hasOwn(value, discriminator.key) ? describe(value[discriminator.key]) : "nothing"
      }`,
    );
    return;
  }

  const closest = results.reduce<JsonSchemaIssue[] | undefined>(
    (best, issues) => (best === undefined || issues.length < best.length ? issues : best),
    undefined,
  );
  if (closest !== undefined && closest.length > 0) {
    for (const issue of closest) {
      report(state, issue.path, issue.message);
    }
    return;
  }
  report(state, path, "does not match any allowed shape");
}

function checkString(schema: JsonObject, value: string, path: string, state: CheckState): void {
  const length = [...value].length;
  const minLength = schema["minLength"];
  if (typeof minLength === "number" && length < minLength) {
    report(state, path, `must be at least ${minLength} characters, got ${length}`);
  }
  const maxLength = schema["maxLength"];
  if (typeof maxLength === "number" && length > maxLength) {
    report(state, path, `must be at most ${maxLength} characters, got ${length}`);
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string") {
    let matcher: RegExp | undefined;
    try {
      matcher = new RegExp(pattern, "u");
    } catch {
      report(
        state,
        path,
        `schema pattern ${JSON.stringify(pattern)} is not a valid regular expression`,
      );
    }
    if (matcher !== undefined && !matcher.test(value)) {
      report(state, path, `must match pattern ${JSON.stringify(pattern)}`);
    }
  }
}

function checkNumber(schema: JsonObject, value: number, path: string, state: CheckState): void {
  const minimum = schema["minimum"];
  if (typeof minimum === "number" && value < minimum) {
    report(state, path, `must be >= ${minimum}, got ${value}`);
  }
  const maximum = schema["maximum"];
  if (typeof maximum === "number" && value > maximum) {
    report(state, path, `must be <= ${maximum}, got ${value}`);
  }
  const exclusiveMinimum = schema["exclusiveMinimum"];
  if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
    report(state, path, `must be > ${exclusiveMinimum}, got ${value}`);
  }
  const exclusiveMaximum = schema["exclusiveMaximum"];
  if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
    report(state, path, `must be < ${exclusiveMaximum}, got ${value}`);
  }
  const multipleOf = schema["multipleOf"];
  if (typeof multipleOf === "number" && multipleOf > 0) {
    const quotient = value / multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      report(state, path, `must be a multiple of ${multipleOf}, got ${value}`);
    }
  }
}

function checkArray(
  schema: JsonObject,
  value: readonly unknown[],
  path: string,
  state: CheckState,
): void {
  const minItems = schema["minItems"];
  if (typeof minItems === "number" && value.length < minItems) {
    report(state, path, `must have at least ${minItems} item(s), got ${value.length}`);
  }
  const maxItems = schema["maxItems"];
  if (typeof maxItems === "number" && value.length > maxItems) {
    report(state, path, `must have at most ${maxItems} item(s), got ${value.length}`);
  }
  if (schema["uniqueItems"] === true) {
    for (let index = 1; index < value.length; index += 1) {
      if (value.slice(0, index).some((earlier) => jsonDeepEqual(earlier, value[index]))) {
        report(state, childPath(path, index), "duplicates an earlier item; items must be unique");
      }
    }
  }
  const items = schema["items"];
  if (typeof items === "boolean" || isObject(items)) {
    value.forEach((item, index) => {
      checkNode(items as SchemaNode, item, childPath(path, index), state);
    });
  }
}

function checkObject(
  schema: JsonObject,
  value: Record<string, unknown>,
  path: string,
  state: CheckState,
): void {
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && (!Object.hasOwn(value, key) || value[key] === undefined)) {
        report(state, childPath(path, key), "is required but missing");
      }
    }
  }

  const minProperties = schema["minProperties"];
  if (typeof minProperties === "number" && Object.keys(value).length < minProperties) {
    report(
      state,
      path,
      `must have at least ${minProperties} propert${minProperties === 1 ? "y" : "ies"}`,
    );
  }

  const properties = isObject(schema["properties"])
    ? (schema["properties"] as Record<string, unknown>)
    : {};
  const additional = schema["additionalProperties"];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      continue;
    }
    const propertySchema = properties[key];
    if (typeof propertySchema === "boolean" || isObject(propertySchema)) {
      checkNode(propertySchema as SchemaNode, child, childPath(path, key), state);
      continue;
    }
    if (additional === false) {
      const known = Object.keys(properties);
      report(
        state,
        childPath(path, key),
        `is not an allowed property${known.length > 0 ? ` (allowed: ${known.join(", ")})` : ""}`,
      );
    } else if (isObject(additional)) {
      checkNode(additional as JsonObject, child, childPath(path, key), state);
    }
  }
}
