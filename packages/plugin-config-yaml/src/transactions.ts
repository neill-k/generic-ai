import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { config as sdkConfig, type ResolvedConfig } from "@generic-ai/sdk";
import * as YAML from "yaml";
import { z } from "zod";

import {
  discoverCanonicalConfig,
  type ConfigConcern,
  type DiscoverCanonicalConfigOptions,
} from "./discovery.js";
import {
  resolveCanonicalConfig,
  type ConfigLoadFailure,
  type ResolveCanonicalConfigOptions,
} from "./resolution.js";
import {
  validateConfigAtStartup,
  type ConfigValidationDiagnostic,
  type StartupValidationOptions,
  type ValidationSchemaSource,
} from "./validation.js";

export type CanonicalConfigEditAction = "set" | "delete";

export interface CanonicalConfigEdit {
  readonly action: CanonicalConfigEditAction;
  readonly concern: ConfigConcern;
  readonly key?: string;
  readonly value?: Record<string, unknown>;
  readonly expectedSha256?: string;
}

export type CanonicalConfigTransactionFailureCode =
  | "NO_EDITS"
  | "INVALID_EDIT"
  | "CONFIG_CONFLICT"
  | "WRITE_FAILED"
  | "VERIFY_FAILED";

export interface CanonicalConfigTransactionFailure {
  readonly code: CanonicalConfigTransactionFailureCode;
  readonly message: string;
  readonly concern?: ConfigConcern;
  readonly key?: string;
  readonly filePath?: string;
}

export interface CanonicalConfigFilePlan {
  readonly action: CanonicalConfigEditAction;
  readonly concern: ConfigConcern;
  readonly key: string;
  readonly filePath: string;
  readonly relativePath: string;
  readonly previousSha256?: string;
  readonly nextSha256?: string;
  readonly content?: string;
}

export interface CanonicalConfigTransactionPlan {
  readonly rootDir: string;
  readonly configDir: string;
  readonly revision: string;
  readonly files: readonly CanonicalConfigFilePlan[];
}

export interface CanonicalConfigTransactionSnapshot {
  readonly rootDir: string;
  readonly configDir: string;
  readonly revision: string;
}

export interface CanonicalConfigTransactionOptions extends StartupValidationOptions {
  readonly edits: readonly CanonicalConfigEdit[];
  readonly expectedRevision?: string;
  readonly schemaSource?: ValidationSchemaSource;
  readonly requireFramework?: boolean;
  readonly fs?: DiscoverCanonicalConfigOptions["fs"] & {
    access?: typeof access;
    mkdir?: typeof mkdir;
    readFile?: typeof readFile;
    rename?: typeof rename;
    rm?: typeof rm;
    writeFile?: typeof writeFile;
  };
}

export type CanonicalConfigTransactionPreviewResult =
  | {
      readonly ok: true;
      readonly plan: CanonicalConfigTransactionPlan;
      readonly failures: [];
    }
  | {
      readonly ok: false;
      readonly failures: readonly CanonicalConfigTransactionFailure[];
    };

export type CanonicalConfigTransactionApplyResult =
  | {
      readonly ok: true;
      readonly plan: CanonicalConfigTransactionPlan;
      readonly config: ResolvedConfig;
      readonly failures: [];
    }
  | {
      readonly ok: false;
      readonly plan?: CanonicalConfigTransactionPlan;
      readonly failures: readonly CanonicalConfigTransactionFailure[];
    };

interface ConfigRootLocation {
  readonly rootDir: string;
  readonly configDir: string;
  readonly files: readonly {
    readonly filePath: string;
    readonly relativePath: string;
  }[];
}

interface FileBackup {
  readonly filePath: string;
  readonly existed: boolean;
  readonly content?: string;
}

type CanonicalConfigVerifyResult =
  | {
      readonly ok: true;
      readonly config: ResolvedConfig;
      readonly failures: [];
      readonly diagnostics: readonly ConfigValidationDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly failures: readonly ConfigLoadFailure[];
      readonly diagnostics: readonly ConfigValidationDiagnostic[];
    };

const zodLike = {
  string: () => z.string(),
  boolean: () => z.boolean(),
  number: () => z.number(),
  unknown: () => z.unknown(),
  literal: (value: string | number | boolean) => z.literal(value),
  object: (shape: Record<string, unknown>) => z.object(shape),
  array: (schema: unknown) => z.array(schema as never),
  record: (valueSchema: unknown) => z.record(z.string(), valueSchema as never),
};
const schemas = sdkConfig.createCanonicalConfigSchemas(
  zodLike as unknown as Parameters<typeof sdkConfig.createCanonicalConfigSchemas>[0],
);

export async function getCanonicalConfigTransactionSnapshot(
  startDir: string,
  options: Omit<CanonicalConfigTransactionOptions, "edits"> = {},
): Promise<CanonicalConfigTransactionSnapshot> {
  const transactionOptions: CanonicalConfigTransactionOptions = {
    ...options,
    edits: [],
  };
  const location = await locateConfigRoot(startDir, transactionOptions);
  return {
    rootDir: location.rootDir,
    configDir: location.configDir,
    revision: await computeRevision(location, transactionOptions),
  };
}

export async function previewCanonicalConfigTransaction(
  startDir: string,
  options: CanonicalConfigTransactionOptions,
): Promise<CanonicalConfigTransactionPreviewResult> {
  const failures: CanonicalConfigTransactionFailure[] = [];

  if (options.edits.length === 0) {
    return {
      ok: false,
      failures: [
        {
          code: "NO_EDITS",
          message: "At least one config edit is required.",
        },
      ],
    };
  }

  const location = await locateConfigRoot(startDir, options);
  const revision = await computeRevision(location, options);

  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
    failures.push({
      code: "CONFIG_CONFLICT",
      message: `Config revision changed from "${options.expectedRevision}" to "${revision}".`,
    });
  }

  const files: CanonicalConfigFilePlan[] = [];
  for (const edit of options.edits) {
    const normalized = normalizeEdit(edit);
    if (!normalized.ok) {
      failures.push(normalized.failure);
      continue;
    }

    const filePath = filePathForEdit(location.configDir, normalized.edit);
    const previousSha256 = await readSha256(filePath, options);

    if (
      normalized.edit.expectedSha256 !== undefined &&
      normalized.edit.expectedSha256 !== previousSha256
    ) {
      failures.push({
        code: "CONFIG_CONFLICT",
        message: `Config file "${filePath}" changed before the transaction could be planned.`,
        concern: normalized.edit.concern,
        key: normalized.edit.key,
        filePath,
      });
      continue;
    }

    if (normalized.edit.action === "delete") {
      files.push({
        action: "delete",
        concern: normalized.edit.concern,
        key: normalized.edit.key,
        filePath,
        relativePath: relative(location.rootDir, filePath),
        ...(previousSha256 === undefined ? {} : { previousSha256 }),
      });
      continue;
    }

    const contentResult = serializeEdit(normalized.edit);
    if (!contentResult.ok) {
      failures.push(contentResult.failure);
      continue;
    }

    files.push({
      action: "set",
      concern: normalized.edit.concern,
      key: normalized.edit.key,
      filePath,
      relativePath: relative(location.rootDir, filePath),
      ...(previousSha256 === undefined ? {} : { previousSha256 }),
      nextSha256: sha256(contentResult.content),
      content: contentResult.content,
    });
  }

  if (failures.length > 0) {
    return {
      ok: false,
      failures,
    };
  }

  return {
    ok: true,
    failures: [],
    plan: {
      rootDir: location.rootDir,
      configDir: location.configDir,
      revision,
      files,
    },
  };
}

export async function applyCanonicalConfigTransaction(
  startDir: string,
  options: CanonicalConfigTransactionOptions,
): Promise<CanonicalConfigTransactionApplyResult> {
  const preview = await previewCanonicalConfigTransaction(startDir, options);
  if (!preview.ok) {
    return preview;
  }

  const backups = await createBackups(preview.plan.files, options);
  try {
    await writePlan(preview.plan, options);

    const verified = await verifyCanonicalConfig(startDir, {
      ...(options.schemaSource === undefined ? {} : { schemaSource: options.schemaSource }),
      ...(options.rejectUnknownPluginNamespaces === undefined
        ? {}
        : { rejectUnknownPluginNamespaces: options.rejectUnknownPluginNamespaces }),
      requireFramework: options.requireFramework ?? true,
    });
    if (!verified.ok) {
      await rollback(backups, options);
      return {
        ok: false,
        plan: preview.plan,
        failures: [
          {
            code: "VERIFY_FAILED",
            message: formatVerifyFailure(verified),
          },
        ],
      };
    }

    return {
      ok: true,
      plan: preview.plan,
      config: verified.config,
      failures: [],
    };
  } catch (error) {
    await rollback(backups, options);
    return {
      ok: false,
      plan: preview.plan,
      failures: [
        {
          code: "WRITE_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function normalizeEdit(edit: CanonicalConfigEdit):
  | {
      readonly ok: true;
      readonly edit: Required<Pick<CanonicalConfigEdit, "action" | "concern" | "key">> &
        Omit<CanonicalConfigEdit, "key">;
    }
  | {
      readonly ok: false;
      readonly failure: CanonicalConfigTransactionFailure;
    } {
  const key =
    edit.concern === "framework" || edit.concern === "hooks" ? edit.concern : edit.key?.trim();

  if (key === undefined || key.length === 0) {
    return {
      ok: false,
      failure: {
        code: "INVALID_EDIT",
        message: `${edit.concern} edits require a non-empty key.`,
        concern: edit.concern,
      },
    };
  }

  if (key.includes("/") || key.includes("\\") || key === "." || key === "..") {
    return {
      ok: false,
      failure: {
        code: "INVALID_EDIT",
        message: `${edit.concern} key "${key}" is not safe for a canonical YAML filename.`,
        concern: edit.concern,
        key,
      },
    };
  }

  if (edit.action === "set" && edit.value === undefined) {
    return {
      ok: false,
      failure: {
        code: "INVALID_EDIT",
        message: `Set edit for ${edit.concern} "${key}" requires a value.`,
        concern: edit.concern,
        key,
      },
    };
  }

  if (edit.action === "delete" && edit.concern === "framework") {
    return {
      ok: false,
      failure: {
        code: "INVALID_EDIT",
        message: "framework.yaml cannot be deleted by a config transaction.",
        concern: edit.concern,
        key,
      },
    };
  }

  return {
    ok: true,
    edit: {
      ...edit,
      key,
    },
  };
}

function serializeEdit(
  edit: Required<Pick<CanonicalConfigEdit, "action" | "concern" | "key">> &
    Omit<CanonicalConfigEdit, "key">,
):
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly failure: CanonicalConfigTransactionFailure } {
  if (edit.value === undefined) {
    return {
      ok: false,
      failure: {
        code: "INVALID_EDIT",
        message: `Set edit for ${edit.concern} "${edit.key}" requires a value.`,
        concern: edit.concern,
        key: edit.key,
      },
    };
  }

  const sourceValue = stripInjectedIdentity(edit.concern, edit.key, edit.value);
  if (!sourceValue.ok) {
    return sourceValue;
  }

  const validationValue = withInjectedIdentity(edit.concern, edit.key, sourceValue.value);
  const parsed = schemaForConcern(edit.concern).safeParse(validationValue);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        code: "INVALID_EDIT",
        message: `Invalid ${edit.concern} "${edit.key}": ${formatSchemaError(parsed.error)}`,
        concern: edit.concern,
        key: edit.key,
      },
    };
  }

  return {
    ok: true,
    content: ensureTrailingNewline(YAML.stringify(sourceValue.value, null, { lineWidth: 0 })),
  };
}

function stripInjectedIdentity(
  concern: ConfigConcern,
  key: string,
  value: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly failure: CanonicalConfigTransactionFailure } {
  const source = { ...value };
  const identityField = concern === "plugin" ? "plugin" : "id";

  if (concern === "framework" || concern === "hooks") {
    return { ok: true, value: source };
  }

  if (source[identityField] !== undefined && source[identityField] !== key) {
    return {
      ok: false,
      failure: {
        code: "INVALID_EDIT",
        message: `${concern} "${key}" cannot declare ${identityField}="${String(source[identityField])}" because config identity is derived from the filename.`,
        concern,
        key,
      },
    };
  }

  delete source[identityField];
  return { ok: true, value: source };
}

function withInjectedIdentity(
  concern: ConfigConcern,
  key: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (concern === "framework" || concern === "hooks") {
    return value;
  }

  if (concern === "plugin") {
    return { plugin: key, ...value };
  }

  return { id: key, ...value };
}

function schemaForConcern(concern: ConfigConcern) {
  switch (concern) {
    case "framework":
      return schemas.framework;
    case "hooks":
      return schemas.hooks;
    case "agent":
      return schemas.agent;
    case "harness":
      return schemas.harness;
    case "plugin":
      return schemas.plugin;
  }
}

async function locateConfigRoot(
  startDir: string,
  options: CanonicalConfigTransactionOptions,
): Promise<ConfigRootLocation> {
  const discovery = await discoverCanonicalConfig(
    startDir,
    options.fs === undefined ? {} : { fs: options.fs },
  );
  if (discovery.rootDir !== undefined && discovery.configDir !== undefined) {
    return {
      rootDir: discovery.rootDir,
      configDir: discovery.configDir,
      files: discovery.files.map((file) => ({
        filePath: file.filePath,
        relativePath: file.relativePath,
      })),
    };
  }

  const rootDir = resolve(startDir);
  return {
    rootDir,
    configDir: join(rootDir, ".generic-ai"),
    files: [],
  };
}

function filePathForEdit(configDir: string, edit: { concern: ConfigConcern; key: string }): string {
  switch (edit.concern) {
    case "framework":
      return join(configDir, "framework.yaml");
    case "hooks":
      return join(configDir, "hooks.yaml");
    case "agent":
      return join(configDir, "agents", `${edit.key}.yaml`);
    case "harness":
      return join(configDir, "harnesses", `${edit.key}.yaml`);
    case "plugin":
      return join(configDir, "plugins", `${edit.key}.yaml`);
  }
}

async function computeRevision(
  location: ConfigRootLocation,
  options: CanonicalConfigTransactionOptions,
): Promise<string> {
  const entries: Array<{ readonly path: string; readonly sha256: string }> = [];

  for (const file of location.files) {
    const fileSha = await readSha256(file.filePath, options);
    if (fileSha !== undefined) {
      entries.push({
        path: file.relativePath,
        sha256: fileSha,
      });
    }
  }

  return sha256(JSON.stringify(entries.sort((left, right) => left.path.localeCompare(right.path))));
}

async function readSha256(
  filePath: string,
  options: CanonicalConfigTransactionOptions,
): Promise<string | undefined> {
  try {
    const content = await (options.fs?.readFile ?? readFile)(filePath, "utf8");
    return sha256(content);
  } catch {
    return undefined;
  }
}

async function createBackups(
  files: readonly CanonicalConfigFilePlan[],
  options: CanonicalConfigTransactionOptions,
): Promise<readonly FileBackup[]> {
  const backups: FileBackup[] = [];
  for (const file of files) {
    try {
      const content = await (options.fs?.readFile ?? readFile)(file.filePath, "utf8");
      backups.push({
        filePath: file.filePath,
        existed: true,
        content,
      });
    } catch {
      backups.push({
        filePath: file.filePath,
        existed: false,
      });
    }
  }
  return backups;
}

async function writePlan(
  plan: CanonicalConfigTransactionPlan,
  options: CanonicalConfigTransactionOptions,
): Promise<void> {
  for (const file of plan.files) {
    if (file.action === "delete") {
      await (options.fs?.rm ?? rm)(file.filePath, { force: true });
      continue;
    }

    if (file.content === undefined) {
      throw new Error(`Missing serialized content for "${file.filePath}".`);
    }

    await (options.fs?.mkdir ?? mkdir)(dirname(file.filePath), { recursive: true });
    const tempPath = `${file.filePath}.${process.pid}.${Date.now()}.tmp`;
    await (options.fs?.writeFile ?? writeFile)(tempPath, file.content, "utf8");
    await (options.fs?.rename ?? rename)(tempPath, file.filePath);
  }
}

async function rollback(
  backups: readonly FileBackup[],
  options: CanonicalConfigTransactionOptions,
): Promise<void> {
  for (const backup of backups) {
    if (!backup.existed) {
      await (options.fs?.rm ?? rm)(backup.filePath, { force: true });
      continue;
    }

    await (options.fs?.mkdir ?? mkdir)(dirname(backup.filePath), { recursive: true });
    await (options.fs?.writeFile ?? writeFile)(backup.filePath, backup.content ?? "", "utf8");
  }
}

async function verifyCanonicalConfig(
  startDir: string,
  options: Omit<ResolveCanonicalConfigOptions, "fs"> &
    StartupValidationOptions & {
      readonly schemaSource?: ValidationSchemaSource;
    },
): Promise<CanonicalConfigVerifyResult> {
  const resolution = await resolveCanonicalConfig(startDir, {
    ...(options.requireFramework === undefined
      ? {}
      : { requireFramework: options.requireFramework }),
  });
  if (!resolution.ok) {
    return {
      ok: false,
      failures: resolution.failures,
      diagnostics: [],
    };
  }

  const config = resolution.config as unknown as ResolvedConfig;
  if (options.schemaSource === undefined) {
    return {
      ok: true,
      config,
      failures: [],
      diagnostics: [],
    };
  }

  const diagnostics = validateConfigAtStartup(config, options.schemaSource, {
    ...(options.rejectUnknownPluginNamespaces === undefined
      ? {}
      : { rejectUnknownPluginNamespaces: options.rejectUnknownPluginNamespaces }),
  }).diagnostics;
  if (diagnostics.length > 0) {
    return {
      ok: false,
      failures: [],
      diagnostics,
    };
  }

  return {
    ok: true,
    config,
    failures: [],
    diagnostics: [],
  };
}

function formatVerifyFailure(result: Extract<CanonicalConfigVerifyResult, { ok: false }>): string {
  const failureMessages = result.failures.map((failure) => failure.message);
  const diagnosticMessages = result.diagnostics.map((diagnostic) => diagnostic.message);
  const messages = [...failureMessages, ...diagnosticMessages];
  return messages.length > 0
    ? `Config transaction was rolled back because verification failed: ${messages.join("; ")}`
    : "Config transaction was rolled back because verification failed.";
}

function formatSchemaError(error: unknown): string {
  if (typeof error === "object" && error !== null && "issues" in error) {
    const issues = (error as { readonly issues?: readonly { readonly message?: string }[] }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map((issue) => issue.message ?? "schema validation failed").join("; ");
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
