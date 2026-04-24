import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureName = `biome-helper-ignore-fixture-${process.pid}`;
const fixtureRoots = [
  [".claude", "worktrees", fixtureName],
  [".codex", "worktrees", fixtureName],
  [".agents", "scratch", fixtureName],
  [".agents", "worktrees", fixtureName],
].map((parts) => path.join(repoRoot, ...parts));

function assertLexicallyInsideRepo(candidatePath) {
  const relativePath = path.relative(repoRoot, candidatePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to clean path outside repo: ${candidatePath}`);
  }
}

async function assertInsideRepo(candidatePath) {
  assertLexicallyInsideRepo(candidatePath);

  const repoRealPath = await fs.realpath(repoRoot);
  const relativeParts = path.relative(repoRoot, candidatePath).split(path.sep).filter(Boolean);
  let currentPath = repoRoot;

  for (const part of relativeParts) {
    currentPath = path.join(currentPath, part);

    let stat;
    try {
      stat = await fs.lstat(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        break;
      }

      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlinked helper path: ${currentPath}`);
    }

    const currentRealPath = await fs.realpath(currentPath);
    const realRelativePath = path.relative(repoRealPath, currentRealPath);
    if (realRelativePath.startsWith("..") || path.isAbsolute(realRelativePath)) {
      throw new Error(`Refusing to clean real path outside repo: ${currentRealPath}`);
    }
  }
}

async function createFixtures() {
  for (const fixtureRoot of fixtureRoots) {
    await assertInsideRepo(fixtureRoot);
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "biome.json"),
      `${JSON.stringify(
        {
          $schema: "https://biomejs.dev/schemas/2.4.11/schema.json",
          linter: {
            enabled: true,
            rules: {
              recommended: false,
              suspicious: {
                noDebugger: "error",
              },
            },
          },
          root: true,
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(fixtureRoot, "ignored.ts"),
      "debugger;\nexport const ignored = true;\n",
    );
  }
}

async function cleanFixtures() {
  for (const fixtureRoot of fixtureRoots) {
    await assertInsideRepo(fixtureRoot);
    await fs.rm(fixtureRoot, { force: true, recursive: true });

    let parent = path.dirname(fixtureRoot);
    while (parent !== repoRoot) {
      await assertInsideRepo(parent);
      try {
        await fs.rm(parent, { recursive: false });
      } catch {
        break;
      }
      parent = path.dirname(parent);
    }
  }
}

function runBiomeCheck() {
  const biomeEntrypoint = path.join(repoRoot, "node_modules", "@biomejs", "biome", "bin", "biome");
  if (!existsSync(biomeEntrypoint)) {
    console.error("Biome is not installed. Run `npm install` before `npm run lint`.");
    return 1;
  }

  const result = spawnSync(
    process.execPath,
    [biomeEntrypoint, "lint", ".", "--vcs-enabled=false", "--diagnostic-level=error"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  return typeof result.status === "number" ? result.status : 1;
}

await createFixtures();

try {
  const status = runBiomeCheck();
  if (status !== 0) {
    console.error(
      "Biome helper ignore check failed. Root biome.json must ignore local helper/worktree directories explicitly.",
    );
    process.exitCode = status;
  } else {
    console.log("Biome helper ignore check OK");
  }
} finally {
  await cleanFixtures();
}
