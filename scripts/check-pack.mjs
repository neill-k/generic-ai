#!/usr/bin/env node
// Proves the public packages work when installed from npm tarballs, the way an outside user gets
// them, rather than through the monorepo's workspace links.
//
//   node scripts/check-pack.mjs              static checks + pack + clean install + import + types
//   node scripts/check-pack.mjs --static     only the checks that need no network or build
//   node scripts/check-pack.mjs --keep       keep the temporary project for inspection
//
// Run `npm run build` first; the full check packs the built dist folders.
//
// What it checks:
//   1. Every public package has the metadata npm needs and depends only on other public packages.
//   2. `npm pack` output holds the files that main/types/exports point at, a LICENSE and a README,
//      and nothing that should stay in the repo (source, tests, build info).
//   3. All tarballs install together into an empty project with plain `npm install`.
//   4. Every export subpath of every package loads in Node from that project.
//   5. A TypeScript file importing every subpath typechecks there under NodeNext resolution.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const staticOnly = args.has("--static");
const keep = args.has("--keep");
const SCOPE = "@generic-ai/";
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];
const FORBIDDEN_IN_TARBALL = [
  [/^src\/(?!styles\.css$)/, "source folder"],
  [/(^|\/)__tests__\//, "test folder"],
  [/\.test\.[cm]?[jt]sx?$/, "test file"],
  [/\.spec\.[cm]?[jt]sx?$/, "test file"],
  [/\.tsbuildinfo$/, "TypeScript build info"],
  [/(^|\/)tsconfig[^/]*\.json$/, "tsconfig"],
  [/(^|\/)\.env/, "env file"],
];

const failures = [];
const fail = (pkgName, message) => failures.push(`${pkgName}: ${message}`);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function run(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function workspacePackages() {
  const all = [];
  for (const group of ["packages", "examples", "apps"]) {
    const dir = path.join(repoRoot, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const pkgPath = path.join(dir, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(pkgPath)) {
        all.push({
          dir: path.join(dir, entry.name),
          rel: `${group}/${entry.name}`,
          json: readJson(pkgPath),
        });
      }
    }
  }
  return all;
}

// Every export target, flattened to { subpath, file } pairs, condition objects included.
function exportTargets(pkg) {
  const targets = [];
  const walk = (subpath, value) => {
    if (typeof value === "string") targets.push({ subpath, file: value });
    else if (value && typeof value === "object")
      for (const v of Object.values(value)) walk(subpath, v);
  };
  const exp = pkg.exports;
  if (typeof exp === "string") walk(".", exp);
  else if (exp && typeof exp === "object") {
    const keys = Object.keys(exp);
    if (keys.some((k) => k.startsWith("."))) for (const k of keys) walk(k, exp[k]);
    else walk(".", exp);
  }
  return targets;
}

function importableSubpaths(pkg) {
  const subpaths = new Set(exportTargets(pkg).map((t) => t.subpath));
  if (subpaths.size === 0) subpaths.add(".");
  return [...subpaths].filter(
    (s) => s !== "./package.json" && !s.endsWith(".css") && !s.includes("*"),
  );
}

function staticChecks(publicPkgs, privateNames) {
  const publicNames = new Set(publicPkgs.map((p) => p.json.name));
  for (const { json: pkg, rel } of publicPkgs) {
    const name = pkg.name ?? rel;
    if (!name.startsWith(SCOPE)) fail(name, `name must start with ${SCOPE}`);
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version ?? ""))
      fail(name, `invalid version ${pkg.version}`);
    if (pkg.license !== "MIT") fail(name, "license must be MIT");
    if (!pkg.description) fail(name, "missing description");
    if (pkg.publishConfig?.access !== "public") fail(name, "publishConfig.access must be public");
    if (pkg.repository?.directory !== rel) fail(name, `repository.directory must be ${rel}`);
    if (!pkg.engines?.node) fail(name, "missing engines.node");
    if (pkg.type !== "module") fail(name, 'type must be "module"');
    if (!pkg.exports) fail(name, "missing exports map");
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) fail(name, "missing files list");

    for (const field of DEP_FIELDS) {
      for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
        if (/^(workspace|file|link|portal):/.test(spec))
          fail(name, `${field}.${dep} uses a local spec (${spec})`);
        if (privateNames.has(dep))
          fail(name, `${field}.${dep} is a private workspace and is never published`);
        if (dep.startsWith(SCOPE) && !publicNames.has(dep) && !privateNames.has(dep)) {
          fail(name, `${field}.${dep} is not a package in this repo`);
        }
      }
    }
  }
}

function packAll(publicPkgs, outDir) {
  const wsArgs = publicPkgs.flatMap((p) => ["--workspace", p.rel]);
  const out = run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir, ...wsArgs],
    {
      cwd: repoRoot,
    },
  );
  const results = JSON.parse(out);
  const byName = new Map(results.map((r) => [r.name, r]));
  for (const { json: pkg } of publicPkgs) {
    const result = byName.get(pkg.name);
    if (!result) {
      fail(pkg.name, "npm pack produced no tarball");
      continue;
    }
    const files = new Set(result.files.map((f) => f.path));
    if (!files.has("LICENSE")) fail(pkg.name, "tarball has no LICENSE");
    if (!files.has("README.md")) fail(pkg.name, "tarball has no README.md");
    for (const file of files) {
      for (const [pattern, label] of FORBIDDEN_IN_TARBALL) {
        if (pattern.test(file)) fail(pkg.name, `tarball contains ${label}: ${file}`);
      }
    }
    const pointed = [...exportTargets(pkg).map((t) => t.file), pkg.main, pkg.types].filter(Boolean);
    for (const target of pointed) {
      const normalized = target.replace(/^\.\//, "");
      if (!files.has(normalized))
        fail(pkg.name, `tarball is missing ${normalized}, which package.json points at`);
    }
  }
  return publicPkgs
    .map((p) => byName.get(p.json.name))
    .filter(Boolean)
    .map((r) => ({
      name: r.name,
      tarball: path.join(outDir, r.filename),
      size: r.size,
      unpacked: r.unpackedSize,
    }));
}

function cleanInstall(publicPkgs, tarballs, projectDir) {
  // Each tarball is a direct dependency, and an override points every nested reference to the same
  // package at it, so internal dependencies resolve to the packed files instead of the registry.
  const dependencies = Object.fromEntries(tarballs.map((t) => [t.name, `file:${t.tarball}`]));
  const overrides = Object.fromEntries(tarballs.map((t) => [t.name, `$${t.name}`]));
  writeFileSync(
    path.join(projectDir, "package.json"),
    `${JSON.stringify({ name: "generic-ai-pack-check", private: true, type: "module", dependencies, overrides }, null, 2)}\n`,
  );
  // A plain install, as a user would run it: no workspace links and none of the repo's hoisted deps.
  try {
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: projectDir });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(-30)
      .join("\n");
    fail("install", `npm install of the packed tarballs failed:\n${output}`);
    return { specifiers: 0, imported: 0 };
  }

  // Runtime: import every export subpath.
  const specifiers = publicPkgs.flatMap(({ json: pkg }) =>
    importableSubpaths(pkg).map((s) => (s === "." ? pkg.name : `${pkg.name}/${s.slice(2)}`)),
  );
  const probe = specifiers
    .map(
      (s) =>
        `try { await import(${JSON.stringify(s)}); ok.push(${JSON.stringify(s)}); } catch (e) { bad.push(${JSON.stringify(s)} + " -> " + (e && e.message ? e.message.split("\\n")[0] : e)); }`,
    )
    .join("\n");
  writeFileSync(
    path.join(projectDir, "probe.mjs"),
    `const ok = []; const bad = [];\n${probe}\nconsole.log(JSON.stringify({ ok, bad }));\n`,
  );
  const result = JSON.parse(
    run(process.execPath, ["probe.mjs"], { cwd: projectDir }).trim().split("\n").pop(),
  );
  for (const line of result.bad) fail("import", line);

  // Types: one file that imports every subpath, checked by the repo's TypeScript under NodeNext.
  writeFileSync(
    path.join(projectDir, "types-probe.ts"),
    `${specifiers.map((s, i) => `import * as m${i} from ${JSON.stringify(s)};`).join("\n")}\nexport const all = [${specifiers.map((_, i) => `m${i}`).join(", ")}];\n`,
  );
  writeFileSync(
    path.join(projectDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        files: ["types-probe.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const typeRoots = path.join(repoRoot, "node_modules", "@types");
  try {
    run(
      process.execPath,
      [tsc, "-p", "tsconfig.json", "--typeRoots", typeRoots, "--pretty", "false"],
      {
        cwd: projectDir,
      },
    );
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(0, 40)
      .join("\n");
    fail("types", `types-probe.ts does not typecheck against the installed tarballs:\n${output}`);
  }
  // Behaviour: a small multi-agent run written the way an outside user would write it.
  const smokeDir = path.join(repoRoot, "scripts", "pack-smoke");
  for (const file of readdirSync(smokeDir).filter((f) => f.endsWith(".mjs"))) {
    writeFileSync(path.join(projectDir, file), readFileSync(path.join(smokeDir, file)));
    try {
      const output = run(process.execPath, [file], { cwd: projectDir, timeout: 120_000 });
      process.stdout.write(output);
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`
        .trim()
        .split("\n")
        .slice(-30)
        .join("\n");
      fail("smoke", `${file} failed against the installed tarballs:\n${output}`);
    }
  }

  return { specifiers: specifiers.length, imported: result.ok.length };
}

function main() {
  const all = workspacePackages();
  const publicPkgs = all.filter((p) => p.rel.startsWith("packages/") && p.json.private !== true);
  const privateNames = new Set(all.filter((p) => p.json.private === true).map((p) => p.json.name));
  for (const p of all) {
    if (!p.rel.startsWith("packages/") && p.json.private !== true) {
      fail(p.json.name, `${p.rel} is outside packages/ and must be "private": true`);
    }
  }

  staticChecks(publicPkgs, privateNames);
  console.log(`pack check: ${publicPkgs.length} public packages, static checks done.`);

  if (!staticOnly && failures.length === 0) {
    const missingBuild = publicPkgs.filter(
      (p) => p.json.main && !existsSync(path.join(p.dir, p.json.main)),
    );
    if (missingBuild.length > 0) {
      fail(
        "build",
        `run \`npm run build\` first (no build output in ${missingBuild.map((p) => p.rel).join(", ")})`,
      );
    } else {
      const work = mkdtempSync(path.join(tmpdir(), "generic-ai-pack-"));
      try {
        const tarballDir = path.join(work, "tarballs");
        const projectDir = path.join(work, "project");
        run("mkdir", ["-p", tarballDir, projectDir]);
        const tarballs = packAll(publicPkgs, tarballDir);
        const total = tarballs.reduce((sum, t) => sum + t.size, 0);
        console.log(
          `pack check: packed ${tarballs.length} tarballs (${(total / 1024).toFixed(0)} KiB).`,
        );
        if (failures.length === 0) {
          const { specifiers, imported } = cleanInstall(publicPkgs, tarballs, projectDir);
          console.log(
            `pack check: clean install done, ${imported}/${specifiers} entry points import.`,
          );
        }
      } finally {
        if (keep) console.log(`pack check: kept ${work}`);
        else rmSync(work, { recursive: true, force: true });
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\npack check failed (${failures.length}):\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("pack check: passed.");
}

main();
