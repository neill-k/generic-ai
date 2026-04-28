import { readFile } from "node:fs/promises";
import {
  discoverCanonicalConfig,
  type ConfigConcern,
  type ConfigDiscoveryFailure,
  type ConfigDiscoveryResult,
  type DiscoverCanonicalConfigOptions,
  type DiscoveredConfigFile,
} from "./discovery.js";

export type ConfigLoadFailureCode =
  | "CONFIG_DIRECTORY_NOT_FOUND"
  | "READ_DIRECTORY_FAILED"
  | "DUPLICATE_CONCERN_FILE"
  | "MISSING_FRAMEWORK_CONFIG"
  | "CONFIG_READ_FAILED"
  | "CONFIG_PARSE_FAILED"
  | "CONFIG_TYPE_MISMATCH";

export interface ConfigLoadFailure {
  code: ConfigLoadFailureCode;
  message: string;
  suggestion: string;
  concern?: ConfigConcern;
  key?: string;
  filePath?: string;
  line?: number;
  column?: number;
  paths?: string[];
}

export interface ResolvedCanonicalConfig {
  rootDir: string;
  configDir: string;
  framework: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  agents: Record<string, Record<string, unknown>>;
  harnesses: Record<string, Record<string, unknown>>;
  plugins: Record<string, Record<string, unknown>>;
  sources: {
    framework?: string;
    hooks?: string;
    agents: Record<string, string>;
    harnesses: Record<string, string>;
    plugins: Record<string, string>;
    order: string[];
  };
}

export type ConfigResolutionResult =
  | {
      ok: true;
      discovery: ConfigDiscoveryResult;
      config: ResolvedCanonicalConfig;
      failures: [];
    }
  | {
      ok: false;
      discovery: ConfigDiscoveryResult;
      failures: ConfigLoadFailure[];
    };

export interface ResolveCanonicalConfigOptions extends DiscoverCanonicalConfigOptions {
  fs?: NonNullable<DiscoverCanonicalConfigOptions["fs"]> & {
    readFile?: typeof readFile;
  };
  requireFramework?: boolean;
}

export async function resolveCanonicalConfig(
  startDir: string,
  options: ResolveCanonicalConfigOptions = {},
): Promise<ConfigResolutionResult> {
  const readFileImpl = options.fs?.readFile ?? readFile;
  const requireFramework = options.requireFramework ?? true;
  const discoveryFs: NonNullable<DiscoverCanonicalConfigOptions["fs"]> = {};
  if (options.fs?.access) {
    discoveryFs.access = options.fs.access;
  }
  if (options.fs?.readdir) {
    discoveryFs.readdir = options.fs.readdir;
  }

  const discovery = await discoverCanonicalConfig(
    startDir,
    Object.keys(discoveryFs).length > 0 ? { fs: discoveryFs } : {},
  );

  const failures: ConfigLoadFailure[] = discovery.failures.map(convertDiscoveryFailure);

  if (!discovery.rootDir || !discovery.configDir) {
    return { ok: false, discovery, failures };
  }

  if (!discovery.frameworkFile && requireFramework) {
    failures.push({
      code: "MISSING_FRAMEWORK_CONFIG",
      message: `Missing "${discovery.configDir}/framework.yaml".`,
      suggestion: `Create ".generic-ai/framework.yaml" to define base framework config.`,
      concern: "framework",
      key: "framework",
      filePath: `${discovery.configDir}/framework.yaml`,
    });
  }

  const frameworkConfig: Record<string, unknown> = {};
  let hooksConfig: Record<string, unknown> | undefined;
  const agents: Record<string, Record<string, unknown>> = {};
  const harnesses: Record<string, Record<string, unknown>> = {};
  const plugins: Record<string, Record<string, unknown>> = {};
  const sources: ResolvedCanonicalConfig["sources"] = {
    agents: {} as Record<string, string>,
    harnesses: {} as Record<string, string>,
    plugins: {} as Record<string, string>,
    order: [] as string[],
  };

  for (const file of discovery.files) {
    const loaded = await loadConcernFile(file, readFileImpl);
    if (!loaded.ok) {
      failures.push(loaded.failure);
      continue;
    }

    if (!isPlainObject(loaded.value)) {
      failures.push({
        code: "CONFIG_TYPE_MISMATCH",
        message: `Expected a YAML mapping at top-level in "${file.filePath}", got ${describeValueType(loaded.value)}.`,
        suggestion: `Ensure "${file.relativePath}" starts with key-value pairs (e.g. "enabled: true").`,
        concern: file.concern,
        key: file.key,
        filePath: file.filePath,
      });
      continue;
    }

    switch (file.concern) {
      case "framework":
        assignInto(frameworkConfig, loaded.value);
        sources.framework = file.filePath;
        sources.order.push(file.filePath);
        break;
      case "hooks":
        hooksConfig = loaded.value;
        sources.hooks = file.filePath;
        sources.order.push(file.filePath);
        break;
      case "agent":
        agents[file.key] = {
          id: file.key,
          ...loaded.value,
        };
        sources.agents[file.key] = file.filePath;
        sources.order.push(file.filePath);
        break;
      case "harness":
        harnesses[file.key] = {
          id: file.key,
          ...loaded.value,
        };
        sources.harnesses[file.key] = file.filePath;
        sources.order.push(file.filePath);
        break;
      case "plugin":
        plugins[file.key] = {
          plugin: file.key,
          ...loaded.value,
        };
        sources.plugins[file.key] = file.filePath;
        sources.order.push(file.filePath);
        break;
    }
  }

  if (failures.length > 0) {
    return { ok: false, discovery, failures };
  }

  return {
    ok: true,
    discovery,
    failures: [],
    config: {
      rootDir: discovery.rootDir,
      configDir: discovery.configDir,
      framework: frameworkConfig,
      ...(hooksConfig === undefined ? {} : { hooks: hooksConfig }),
      agents,
      harnesses,
      plugins,
      sources,
    },
  };
}

function convertDiscoveryFailure(failure: ConfigDiscoveryFailure): ConfigLoadFailure {
  return {
    code: failure.code,
    message: failure.message,
    suggestion: failure.suggestion,
    ...(failure.concern ? { concern: failure.concern } : {}),
    ...(failure.key ? { key: failure.key } : {}),
    ...(failure.path ? { filePath: failure.path } : {}),
    ...(failure.paths ? { paths: failure.paths } : {}),
  };
}

async function loadConcernFile(
  file: DiscoveredConfigFile,
  readFileImpl: typeof readFile,
): Promise<
  | { ok: true; value: unknown }
  | {
      ok: false;
      failure: ConfigLoadFailure;
    }
> {
  let raw: string;
  try {
    raw = await readFileImpl(file.filePath, "utf8");
  } catch {
    return {
      ok: false,
      failure: {
        code: "CONFIG_READ_FAILED",
        message: `Failed to read config file "${file.filePath}".`,
        suggestion: `Verify the file exists and is readable.`,
        concern: file.concern,
        key: file.key,
        filePath: file.filePath,
      },
    };
  }

  const parsed = await parseYamlDocument(raw, file.filePath);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: {
        code: "CONFIG_PARSE_FAILED",
        message: parsed.error.message,
        suggestion: `Fix YAML syntax in "${file.relativePath}" near line ${parsed.error.line}.`,
        concern: file.concern,
        key: file.key,
        filePath: file.filePath,
        line: parsed.error.line,
        column: parsed.error.column,
      },
    };
  }

  return { ok: true, value: parsed.value };
}

async function parseYamlDocument(
  raw: string,
  filePath: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: YamlParseErrorDetails }> {
  const yamlModuleName = "yaml";
  try {
    const yamlModule = (await import(yamlModuleName)) as {
      parse?: (source: string) => unknown;
    };

    if (typeof yamlModule.parse === "function") {
      try {
        const value = yamlModule.parse(raw);
        return { ok: true, value };
      } catch (error) {
        const details = extractYamlModuleError(error, filePath);
        return { ok: false, error: details };
      }
    }
  } catch {
    // Dependency is optional while this package is being wired.
  }

  try {
    return { ok: true, value: parseSimpleYaml(raw, filePath) };
  } catch (error) {
    if (error instanceof SimpleYamlParseError) {
      return {
        ok: false,
        error: {
          message: `${filePath}:${error.line}:${error.column} ${error.message}`,
          line: error.line,
          column: error.column,
        },
      };
    }

    return {
      ok: false,
      error: {
        message: `${filePath}:1:1 Failed to parse YAML content.`,
        line: 1,
        column: 1,
      },
    };
  }
}

interface YamlParseErrorDetails {
  message: string;
  line: number;
  column: number;
}

function extractYamlModuleError(error: unknown, filePath: string): YamlParseErrorDetails {
  const fallback = {
    message: `${filePath}:1:1 Failed to parse YAML content.`,
    line: 1,
    column: 1,
  };

  if (!error || typeof error !== "object") {
    return fallback;
  }

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "Failed to parse YAML content.";

  const linePos =
    "linePos" in error && Array.isArray(error.linePos) && error.linePos.length > 0
      ? error.linePos[0]
      : undefined;

  const line = linePos && typeof linePos.line === "number" ? linePos.line : 1;
  const column = linePos && typeof linePos.col === "number" ? linePos.col : 1;

  return {
    message: `${filePath}:${line}:${column} ${message}`,
    line,
    column,
  };
}

class SimpleYamlParseError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

interface ParsedLine {
  readonly lineNumber: number;
  readonly indent: number;
  readonly content: string;
}

function parseSimpleYaml(raw: string, filePath: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to YAML parser for friendlier diagnostics.
    }
  }

  const lines = preprocessYamlLines(raw, filePath);
  const startIndex = nextContentLine(lines, 0);
  if (startIndex < 0) {
    return {};
  }

  const startLine = lines[startIndex];
  if (!startLine) {
    return {};
  }

  const [value, nextIndex] = parseYamlBlock(lines, startIndex, startLine.indent);
  const trailingIndex = nextContentLine(lines, nextIndex);
  if (trailingIndex >= 0) {
    const trailingLine = lines[trailingIndex];
    if (!trailingLine) {
      return value;
    }
    throw new SimpleYamlParseError(
      "Unexpected trailing content.",
      trailingLine.lineNumber,
      trailingLine.indent + 1,
    );
  }

  return value;
}

function preprocessYamlLines(raw: string, filePath: string): ParsedLine[] {
  const result: ParsedLine[] = [];
  const sourceLines = raw.replaceAll("\r\n", "\n").split("\n");

  for (let index = 0; index < sourceLines.length; index += 1) {
    const original = sourceLines[index] ?? "";
    if (original.includes("\t")) {
      throw new SimpleYamlParseError(
        `Tabs are not supported in YAML indentation (${filePath}).`,
        index + 1,
        original.indexOf("\t") + 1,
      );
    }

    const withoutComment = stripInlineComment(original);
    const content = withoutComment.trim();
    const indent = content.length === 0 ? 0 : countLeadingSpaces(withoutComment);

    if (content.length > 0 && indent % 2 !== 0) {
      throw new SimpleYamlParseError(
        "Use 2-space indentation for nested YAML blocks.",
        index + 1,
        indent + 1,
      );
    }

    result.push({
      lineNumber: index + 1,
      indent,
      content,
    });
  }

  return result;
}

function parseYamlBlock(lines: ParsedLine[], index: number, indent: number): [unknown, number] {
  const line = lines[index];
  if (!line) {
    throw new SimpleYamlParseError("Unexpected end of file.", 1, 1);
  }

  if (line.indent !== indent) {
    throw new SimpleYamlParseError("Unexpected indentation.", line.lineNumber, line.indent + 1);
  }

  if (line.content.startsWith("- ")) {
    return parseYamlSequence(lines, index, indent);
  }

  return parseYamlMapping(lines, index, indent);
}

function parseYamlSequence(
  lines: ParsedLine[],
  index: number,
  indent: number,
): [unknown[], number] {
  const values: unknown[] = [];
  let current = index;

  while (current < lines.length) {
    current = nextContentLine(lines, current);
    if (current < 0) {
      break;
    }

    const line = lines[current];
    if (!line) {
      break;
    }
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new SimpleYamlParseError(
        "Unexpected indentation in YAML sequence item.",
        line.lineNumber,
        line.indent + 1,
      );
    }
    if (!line.content.startsWith("- ")) {
      break;
    }

    const itemText = line.content.slice(2).trimStart();
    if (itemText.length === 0) {
      const nestedIndex = nextContentLine(lines, current + 1);
      const nestedLine = nestedIndex < 0 ? undefined : lines[nestedIndex];
      if (!nestedLine || nestedLine.indent <= indent) {
        throw new SimpleYamlParseError(
          "Missing value for YAML sequence item.",
          line.lineNumber,
          indent + 1,
        );
      }
      if (nestedLine.indent !== indent + 2) {
        throw new SimpleYamlParseError(
          "Nested YAML sequence content must be indented by 2 spaces.",
          nestedLine.lineNumber,
          nestedLine.indent + 1,
        );
      }

      const [nestedValue, nextIndex] = parseYamlBlock(lines, nestedIndex, indent + 2);
      values.push(nestedValue);
      current = nextIndex;
      continue;
    }

    if (looksLikeInlineMapping(itemText)) {
      const inlineIndex = line.content.indexOf(itemText);
      const [key, valuePart] = splitKeyValue(itemText, line.lineNumber, inlineIndex + 1);
      const itemObject: Record<string, unknown> = {};
      itemObject[key] = parseYamlScalar(valuePart, line.lineNumber, inlineIndex + key.length + 2);
      values.push(itemObject);
      current += 1;
      continue;
    }

    values.push(parseYamlScalar(itemText, line.lineNumber, indent + 3));
    current += 1;
  }

  return [values, current];
}

function parseYamlMapping(
  lines: ParsedLine[],
  index: number,
  indent: number,
): [Record<string, unknown>, number] {
  const value: Record<string, unknown> = {};
  let current = index;

  while (current < lines.length) {
    current = nextContentLine(lines, current);
    if (current < 0) {
      break;
    }

    const line = lines[current];
    if (!line) {
      break;
    }
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new SimpleYamlParseError(
        "Unexpected indentation in YAML mapping.",
        line.lineNumber,
        line.indent + 1,
      );
    }
    if (line.content.startsWith("- ")) {
      throw new SimpleYamlParseError(
        "Sequence item where a mapping key was expected.",
        line.lineNumber,
        line.indent + 1,
      );
    }

    const [key, valuePart] = splitKeyValue(line.content, line.lineNumber, line.indent + 1);
    if (Object.hasOwn(value, key)) {
      throw new SimpleYamlParseError(
        `Duplicate YAML key "${key}".`,
        line.lineNumber,
        line.indent + 1,
      );
    }

    if (valuePart.length === 0) {
      const nestedIndex = nextContentLine(lines, current + 1);
      const nestedLine = nestedIndex < 0 ? undefined : lines[nestedIndex];
      if (!nestedLine || nestedLine.indent <= indent) {
        value[key] = {};
        current += 1;
        continue;
      }

      if (nestedLine.indent !== indent + 2) {
        throw new SimpleYamlParseError(
          "Nested YAML mapping content must be indented by 2 spaces.",
          nestedLine.lineNumber,
          nestedLine.indent + 1,
        );
      }

      const [nestedValue, nextIndex] = parseYamlBlock(lines, nestedIndex, indent + 2);
      value[key] = nestedValue;
      current = nextIndex;
      continue;
    }

    value[key] = parseYamlScalar(valuePart, line.lineNumber, line.indent + key.length + 2);
    current += 1;
  }

  return [value, current];
}

function nextContentLine(lines: ParsedLine[], index: number): number {
  for (let next = index; next < lines.length; next += 1) {
    const line = lines[next];
    if (line && line.content.length > 0) {
      return next;
    }
  }
  return -1;
}

function splitKeyValue(content: string, line: number, column: number): [string, string] {
  const delimiter = findKeyValueDelimiter(content);
  if (delimiter < 0) {
    throw new SimpleYamlParseError("Expected a ':' in YAML mapping entry.", line, column);
  }

  const key = content.slice(0, delimiter).trim();
  if (key.length === 0) {
    throw new SimpleYamlParseError("YAML mapping key cannot be empty.", line, column);
  }

  const valuePart = content.slice(delimiter + 1).trimStart();
  return [key, valuePart];
}

function findKeyValueDelimiter(content: string): number {
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (!char) {
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && char === ":") {
      return index;
    }
  }

  return -1;
}

function parseYamlScalar(value: string, line: number, column: number): unknown {
  const lower = value.toLowerCase();
  if (lower === "true") {
    return true;
  }
  if (lower === "false") {
    return false;
  }
  if (lower === "null" || value === "~") {
    return null;
  }

  if (value === "{}") {
    return {};
  }
  if (value === "[]") {
    return [];
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new SimpleYamlParseError("Invalid double-quoted YAML string.", line, column);
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }

  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      throw new SimpleYamlParseError("Invalid inline YAML collection.", line, column);
    }
  }

  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
}

function stripInlineComment(input: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (!char) {
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && char === "#") {
      return input.slice(0, index);
    }
  }

  return input;
}

function countLeadingSpaces(input: string): number {
  let count = 0;
  for (const char of input) {
    if (char === " ") {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

function looksLikeInlineMapping(value: string): boolean {
  return findKeyValueDelimiter(value) > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "an array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
