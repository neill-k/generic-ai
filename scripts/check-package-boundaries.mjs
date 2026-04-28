import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(repoRoot, "packages");

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".mts", ".cts"]);

function packageKind(packageName) {
  if (packageName === "@generic-ai/core") {
    return "core";
  }
  if (packageName === "@generic-ai/sdk") {
    return "sdk";
  }
  if (packageName.startsWith("@generic-ai/plugin-")) {
    return "plugin";
  }
  if (packageName.startsWith("@generic-ai/preset-")) {
    return "preset";
  }

  return "other";
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function collectFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }

    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractSpecifiers(contents) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`]+?\s+from\s+)?["']([^"'`]+)["']/g,
    /\bexport\s+(?:type\s+)?[^"'`]*?\sfrom\s+["']([^"'`]+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function isForbiddenByRule(specifier, rule) {
  return rule.some((candidate) => {
    if (specifier === candidate || specifier.startsWith(`${candidate}/`)) {
      return true;
    }

    if (candidate.endsWith("-") && specifier.startsWith(candidate)) {
      return true;
    }

    return false;
  });
}

function collectPackageSourceFiles(packageDirectory) {
  // Import enforcement is intentionally source-only. Package-local tests and
  // scripts can exercise cross-package integration, but published/runtime
  // sources under src/ must honor the documented package boundaries.
  const scanDirectory = path.join(packageDirectory, "src");
  try {
    return collectFiles(scanDirectory);
  } catch {
    return [];
  }
}

const workspacePackages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = path.join(packagesDir, entry.name);
    const packageJsonPath = path.join(directory, "package.json");
    const packageJson = readJson(packageJsonPath);

    return {
      directory,
      packageJsonPath,
      packageJson,
      packageName: packageJson.name,
      kind: packageKind(packageJson.name),
    };
  });

const internalPackageNames = new Set(workspacePackages.map((pkg) => pkg.packageName));
const violations = [];

for (const workspacePackage of workspacePackages) {
  if (
    workspacePackage.kind === "other" &&
    typeof workspacePackage.packageName === "string" &&
    workspacePackage.packageName.startsWith("@generic-ai/")
  ) {
    violations.push(
      `${path.relative(repoRoot, workspacePackage.packageJsonPath)}: package "${workspacePackage.packageName}" is not assigned to a documented Generic AI layer`,
    );
  }

  const internalDeps = [];

  for (const field of dependencyFields) {
    const deps = workspacePackage.packageJson[field] ?? {};
    for (const dependencyName of Object.keys(deps)) {
      if (internalPackageNames.has(dependencyName)) {
        internalDeps.push({ field, dependencyName });
      }
    }
  }

  const dependencyRules =
    workspacePackage.kind === "core"
      ? ["@generic-ai/plugin-", "@generic-ai/preset-"]
      : workspacePackage.kind === "sdk"
        ? ["@generic-ai/core", "@generic-ai/plugin-", "@generic-ai/preset-"]
        : workspacePackage.kind === "plugin"
          ? ["@generic-ai/core", "@generic-ai/preset-"]
          : [];

  for (const { field, dependencyName } of internalDeps) {
    if (
      dependencyRules.some((rule) =>
        rule.endsWith("-") ? dependencyName.startsWith(rule) : dependencyName === rule,
      )
    ) {
      violations.push(
        `${path.relative(repoRoot, workspacePackage.packageJsonPath)}: forbidden ${field} entry "${dependencyName}" for ${workspacePackage.kind} packages`,
      );
    }
  }

  const importRules =
    workspacePackage.kind === "core"
      ? ["@generic-ai/plugin-", "@generic-ai/preset-"]
      : workspacePackage.kind === "sdk"
        ? ["@generic-ai/core", "@generic-ai/plugin-", "@generic-ai/preset-"]
        : workspacePackage.kind === "plugin"
          ? ["@generic-ai/core", "@generic-ai/preset-"]
          : [];

  const sourceFiles = collectPackageSourceFiles(workspacePackage.directory);
  for (const sourceFile of sourceFiles) {
    const contents = readFileSync(sourceFile, "utf8");
    for (const specifier of extractSpecifiers(contents)) {
      if (isForbiddenByRule(specifier, importRules)) {
        violations.push(
          `${path.relative(repoRoot, sourceFile)}: forbidden import "${specifier}" for ${workspacePackage.kind} packages`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Package boundary violations detected:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Package boundaries OK");
