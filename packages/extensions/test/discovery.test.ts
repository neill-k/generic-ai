// Adapted from pi (badlogic/pi-mono, packages/coding-agent/test/extensions-discovery.test.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAndLoadExtensions, loadExtensions } from "../src/loader.js";

describe("extensions discovery", () => {
  let tempDir: string;
  let extensionsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "generic-ai-ext-test-"));
    extensionsDir = path.join(tempDir, ".generic-ai", "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const extensionCode = `
    export default function(api) {
      api.registerCommand("test", { handler: async () => {} });
    }
  `;

  const extensionCodeWithTool = (toolName: string) => `
    export default function(api) {
      api.registerTool({
        name: "${toolName}",
        label: "${toolName}",
        description: "Test tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      });
    }
  `;

  const load = () => discoverAndLoadExtensions({ cwd: tempDir });
  const names = (paths: readonly { path: string }[]) =>
    paths.map((extension) => path.relative(extensionsDir, extension.path)).sort();

  it("discovers direct .ts files in extensions/", async () => {
    fs.writeFileSync(path.join(extensionsDir, "foo.ts"), extensionCode);
    fs.writeFileSync(path.join(extensionsDir, "bar.ts"), extensionCode);

    const result = await load();

    expect(result.errors).toHaveLength(0);
    expect(names(result.extensions)).toEqual(["bar.ts", "foo.ts"]);
  });

  it("discovers direct .js and .mjs files in extensions/", async () => {
    fs.writeFileSync(path.join(extensionsDir, "foo.js"), extensionCode);
    fs.writeFileSync(path.join(extensionsDir, "bar.mjs"), extensionCode);

    const result = await load();

    expect(result.errors).toHaveLength(0);
    expect(names(result.extensions)).toEqual(["bar.mjs", "foo.js"]);
  });

  it("discovers subdirectory with index.ts", async () => {
    const subdir = path.join(extensionsDir, "my-extension");
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);

    const result = await load();

    expect(result.errors).toHaveLength(0);
    expect(names(result.extensions)).toEqual([path.join("my-extension", "index.ts")]);
  });

  it("prefers index.ts over index.js", async () => {
    const subdir = path.join(extensionsDir, "my-extension");
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);
    fs.writeFileSync(path.join(subdir, "index.js"), extensionCode);

    const result = await load();

    expect(names(result.extensions)).toEqual([path.join("my-extension", "index.ts")]);
  });

  it("package.json can declare multiple extensions and takes precedence over index.ts", async () => {
    const subdir = path.join(extensionsDir, "my-package");
    fs.mkdirSync(path.join(subdir, "src"), { recursive: true });
    fs.writeFileSync(path.join(subdir, "src", "main.ts"), extensionCode);
    fs.writeFileSync(path.join(subdir, "src", "other.ts"), extensionCode);
    fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);
    fs.writeFileSync(
      path.join(subdir, "package.json"),
      JSON.stringify({
        name: "my-package",
        genericAi: { extensions: ["./src/main.ts", "./src/other.ts", "./src/missing.ts"] },
      }),
    );

    const result = await load();

    expect(result.errors).toHaveLength(0);
    expect(names(result.extensions)).toEqual([
      path.join("my-package", "src", "main.ts"),
      path.join("my-package", "src", "other.ts"),
    ]);
  });

  it("ignores package.json without a genericAi field and falls back to index.ts", async () => {
    const subdir = path.join(extensionsDir, "my-package");
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);
    fs.writeFileSync(path.join(subdir, "package.json"), JSON.stringify({ name: "my-package" }));

    const result = await load();

    expect(names(result.extensions)).toEqual([path.join("my-package", "index.ts")]);
  });

  it("ignores subdirectories without an index or manifest, and does not recurse further", async () => {
    const subdir = path.join(extensionsDir, "not-an-extension");
    fs.mkdirSync(path.join(subdir, "deeper"), { recursive: true });
    fs.writeFileSync(path.join(subdir, "helper.ts"), extensionCode);
    fs.writeFileSync(path.join(subdir, "deeper", "index.ts"), extensionCode);

    const result = await load();

    expect(result.extensions).toHaveLength(0);
  });

  it("loads extensions and registers commands and tools", async () => {
    fs.writeFileSync(path.join(extensionsDir, "commands.ts"), extensionCode);
    fs.writeFileSync(path.join(extensionsDir, "tools.ts"), extensionCodeWithTool("my_tool"));

    const result = await load();

    expect(result.runner.getCommands().map((command) => command.name)).toEqual(["test"]);
    expect(result.runner.getTools().map((tool) => tool.name)).toEqual(["my_tool"]);
  });

  it("reports errors for invalid extension code and still loads the rest", async () => {
    fs.writeFileSync(path.join(extensionsDir, "broken.ts"), "export default function( {");
    fs.writeFileSync(path.join(extensionsDir, "good.ts"), extensionCode);

    const result = await load();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain("broken.ts");
    expect(names(result.extensions)).toEqual(["good.ts"]);
  });

  it("reports an error when an extension throws during initialisation", async () => {
    fs.writeFileSync(
      path.join(extensionsDir, "throws.ts"),
      `export default function() { throw new Error("Initialisation failed!"); }`,
    );

    const result = await load();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("Initialisation failed!");
    expect(result.extensions).toHaveLength(0);
  });

  it("reports an error when an extension has no default export", async () => {
    fs.writeFileSync(path.join(extensionsDir, "nodefault.ts"), `export const x = 1;`);

    const result = await load();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("no default export");
  });

  it("loads explicitly configured files and directories", async () => {
    const elsewhere = path.join(tempDir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "one.ts"), extensionCode);
    fs.writeFileSync(path.join(elsewhere, "two.ts"), extensionCode);
    const single = path.join(tempDir, "single.ts");
    fs.writeFileSync(single, extensionCode);

    const result = await discoverAndLoadExtensions({
      cwd: tempDir,
      paths: ["elsewhere", single],
      includeDefaults: false,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.extensions.map((extension) => path.basename(extension.path))).toEqual([
      "one.ts",
      "two.ts",
      "single.ts",
    ]);
  });

  it("searches the agent directory and skips duplicates", async () => {
    const agentDir = path.join(tempDir, "agent");
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "extensions", "global.ts"), extensionCode);
    fs.writeFileSync(path.join(extensionsDir, "local.ts"), extensionCode);

    const result = await discoverAndLoadExtensions({
      cwd: tempDir,
      agentDir,
      paths: [path.join(extensionsDir, "local.ts")],
    });

    expect(result.extensions.map((extension) => path.basename(extension.path))).toEqual([
      "local.ts",
      "global.ts",
    ]);
  });

  it("loadExtensions with no paths loads nothing", async () => {
    const result = await loadExtensions([]);
    expect(result.extensions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
