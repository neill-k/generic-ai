import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

export type ConfigConcern = "framework" | "hooks" | "agent" | "harness" | "plugin";

export interface DiscoveredConfigFile {
  concern: ConfigConcern;
  key: string;
  filePath: string;
  relativePath: string;
}

export type ConfigDiscoveryFailureCode =
  | "CONFIG_DIRECTORY_NOT_FOUND"
  | "READ_DIRECTORY_FAILED"
  | "DUPLICATE_CONCERN_FILE";

export interface ConfigDiscoveryFailure {
  code: ConfigDiscoveryFailureCode;
  message: string;
  suggestion: string;
  concern?: ConfigConcern;
  key?: string;
  path?: string;
  paths?: string[];
}

export interface ConfigDiscoveryResult {
  startDir: string;
  rootDir?: string;
  configDir?: string;
  frameworkFile?: DiscoveredConfigFile;
  hooksFile?: DiscoveredConfigFile;
  agentFiles: DiscoveredConfigFile[];
  harnessFiles: DiscoveredConfigFile[];
  pluginFiles: DiscoveredConfigFile[];
  files: DiscoveredConfigFile[];
  failures: ConfigDiscoveryFailure[];
}

export interface DiscoverCanonicalConfigOptions {
  fs?: {
    access?: typeof access;
    readdir?: typeof readdir;
  };
}

const CONFIG_DIR_NAME = ".generic-ai";
const AGENTS_DIR_NAME = "agents";
const HARNESSES_DIR_NAME = "harnesses";
const PLUGINS_DIR_NAME = "plugins";
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const FRAMEWORK_FILENAMES = ["framework.yaml", "framework.yml"] as const;
const HOOKS_FILENAMES = ["hooks.yaml", "hooks.yml"] as const;

export async function discoverCanonicalConfig(
  startDir: string,
  options: DiscoverCanonicalConfigOptions = {},
): Promise<ConfigDiscoveryResult> {
  const accessImpl = options.fs?.access ?? access;
  const readdirImpl = options.fs?.readdir ?? readdir;
  const normalizedStartDir = resolve(startDir);
  const failures: ConfigDiscoveryFailure[] = [];

  const configRoot = await findConfigRoot(normalizedStartDir, accessImpl);
  if (!configRoot) {
    failures.push({
      code: "CONFIG_DIRECTORY_NOT_FOUND",
      message: `No "${CONFIG_DIR_NAME}" directory was found from "${normalizedStartDir}" up to the filesystem root.`,
      suggestion: `Create "${CONFIG_DIR_NAME}" at your project root and add "framework.yaml".`,
      path: normalizedStartDir,
    });

    return {
      startDir: normalizedStartDir,
      agentFiles: [],
      harnessFiles: [],
      pluginFiles: [],
      files: [],
      failures,
    };
  }

  const configDir = join(configRoot, CONFIG_DIR_NAME);
  const frameworkFiles = FRAMEWORK_FILENAMES.map((name) => join(configDir, name)).filter(
    (filePath) => hasYamlExt(filePath),
  );

  const foundFrameworkFiles: string[] = [];
  for (const filePath of frameworkFiles) {
    if (await pathExists(filePath, accessImpl)) {
      foundFrameworkFiles.push(filePath);
    }
  }

  if (foundFrameworkFiles.length > 1) {
    failures.push({
      code: "DUPLICATE_CONCERN_FILE",
      message: `Found multiple framework config files: ${foundFrameworkFiles.join(", ")}.`,
      suggestion: `Keep only one framework file in "${CONFIG_DIR_NAME}" (prefer "framework.yaml").`,
      concern: "framework",
      key: "framework",
      paths: [...foundFrameworkFiles].sort(comparePath),
    });
  }

  const sortedFrameworkFiles = [...foundFrameworkFiles].sort(comparePath);
  const primaryFrameworkFile = sortedFrameworkFiles[0];
  const frameworkFile =
    primaryFrameworkFile === undefined
      ? undefined
      : createDiscoveredFile(configRoot, primaryFrameworkFile, "framework", "framework");

  const hooksFiles = HOOKS_FILENAMES.map((name) => join(configDir, name)).filter((filePath) =>
    hasYamlExt(filePath),
  );
  const foundHooksFiles: string[] = [];
  for (const filePath of hooksFiles) {
    if (await pathExists(filePath, accessImpl)) {
      foundHooksFiles.push(filePath);
    }
  }

  if (foundHooksFiles.length > 1) {
    failures.push({
      code: "DUPLICATE_CONCERN_FILE",
      message: `Found multiple hooks config files: ${foundHooksFiles.join(", ")}.`,
      suggestion: `Keep only one hooks file in "${CONFIG_DIR_NAME}" (prefer "hooks.yaml").`,
      concern: "hooks",
      key: "hooks",
      paths: [...foundHooksFiles].sort(comparePath),
    });
  }

  const sortedHooksFiles = [...foundHooksFiles].sort(comparePath);
  const primaryHooksFile = sortedHooksFiles[0];
  const hooksFile =
    primaryHooksFile === undefined
      ? undefined
      : createDiscoveredFile(configRoot, primaryHooksFile, "hooks", "hooks");

  const agentFiles = await discoverConcernFiles({
    rootDir: configRoot,
    concern: "agent",
    concernDir: join(configDir, AGENTS_DIR_NAME),
    readdirImpl,
    accessImpl,
    failures,
  });

  const pluginFiles = await discoverConcernFiles({
    rootDir: configRoot,
    concern: "plugin",
    concernDir: join(configDir, PLUGINS_DIR_NAME),
    readdirImpl,
    accessImpl,
    failures,
  });

  const harnessFiles = await discoverConcernFiles({
    rootDir: configRoot,
    concern: "harness",
    concernDir: join(configDir, HARNESSES_DIR_NAME),
    readdirImpl,
    accessImpl,
    failures,
  });

  const files = [
    ...(frameworkFile ? [frameworkFile] : []),
    ...(hooksFile ? [hooksFile] : []),
    ...agentFiles,
    ...harnessFiles,
    ...pluginFiles,
  ].sort(compareDiscoveredFile);

  return {
    startDir: normalizedStartDir,
    rootDir: configRoot,
    configDir,
    ...(frameworkFile ? { frameworkFile } : {}),
    ...(hooksFile ? { hooksFile } : {}),
    agentFiles,
    harnessFiles,
    pluginFiles,
    files,
    failures,
  };
}

async function discoverConcernFiles(args: {
  rootDir: string;
  concern: ConfigConcern;
  concernDir: string;
  readdirImpl: typeof readdir;
  accessImpl: typeof access;
  failures: ConfigDiscoveryFailure[];
}): Promise<DiscoveredConfigFile[]> {
  const concernFiles: DiscoveredConfigFile[] = [];
  const { concernDir, readdirImpl, accessImpl, failures, concern, rootDir } = args;

  if (!(await pathExists(concernDir, accessImpl))) {
    return concernFiles;
  }

  let directoryEntries: string[] = [];
  try {
    directoryEntries = await readdirImpl(concernDir);
  } catch {
    failures.push({
      code: "READ_DIRECTORY_FAILED",
      message: `Failed to read "${concernDir}" while discovering ${concern} config files.`,
      suggestion: `Verify "${concernDir}" exists and is readable.`,
      concern,
      path: concernDir,
    });
    return concernFiles;
  }

  const seenByKey = new Map<string, string>();
  const candidatePaths = directoryEntries
    .map((entry) => join(concernDir, entry))
    .filter((filePath) => hasYamlExt(filePath))
    .sort(comparePath);

  for (const filePath of candidatePaths) {
    const key = basename(filePath, extname(filePath));
    const previousFile = seenByKey.get(key);

    if (previousFile) {
      failures.push({
        code: "DUPLICATE_CONCERN_FILE",
        message: `Found duplicate ${concern} config for key "${key}": ${previousFile} and ${filePath}.`,
        suggestion: `Keep a single file for "${key}" in "${concernDir}" (prefer ".yaml").`,
        concern,
        key,
        paths: [previousFile, filePath].sort(comparePath),
      });
      continue;
    }

    seenByKey.set(key, filePath);
    concernFiles.push(createDiscoveredFile(rootDir, filePath, concern, key));
  }

  return concernFiles.sort(compareDiscoveredFile);
}

function createDiscoveredFile(
  rootDir: string,
  filePath: string,
  concern: ConfigConcern,
  key: string,
): DiscoveredConfigFile {
  const absoluteFilePath = resolve(filePath);
  return {
    concern,
    key,
    filePath: absoluteFilePath,
    relativePath: relative(rootDir, absoluteFilePath),
  };
}

function hasYamlExt(filePath: string): boolean {
  return YAML_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function findConfigRoot(
  startDir: string,
  accessImpl: typeof access,
): Promise<string | undefined> {
  let currentDir = resolve(startDir);

  while (true) {
    const candidate = join(currentDir, CONFIG_DIR_NAME);
    if (await pathExists(candidate, accessImpl)) {
      return currentDir;
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

async function pathExists(filePath: string, accessImpl: typeof access): Promise<boolean> {
  try {
    await accessImpl(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function compareDiscoveredFile(a: DiscoveredConfigFile, b: DiscoveredConfigFile): number {
  const concernOrder = compareConcern(a.concern, b.concern);
  if (concernOrder !== 0) {
    return concernOrder;
  }

  const keyOrder = a.key.localeCompare(b.key);
  if (keyOrder !== 0) {
    return keyOrder;
  }

  return comparePath(a.filePath, b.filePath);
}

function compareConcern(left: ConfigConcern, right: ConfigConcern): number {
  const weight: Record<ConfigConcern, number> = {
    framework: 0,
    hooks: 1,
    agent: 2,
    harness: 3,
    plugin: 4,
  };
  return weight[left] - weight[right];
}

function comparePath(left: string, right: string): number {
  return left.localeCompare(right);
}
