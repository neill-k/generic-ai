// Adapted from pi (badlogic/pi-mono, packages/coding-agent/test/trust-manager.test.ts and
// project-trust-saved-decision.test.ts). Copyright (c) 2026 Earendil Inc. MIT License; see
// THIRD_PARTY_NOTICES.md.

import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getProjectTrustOptions,
  hasTrustRequiringProjectResources,
  loadPromptTemplates,
  loadSkills,
  ProjectTrustStore,
  resolveProjectTrusted,
} from "../src/index.js";

let tempDir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  tempDir = join(realpathSync(tmpdir()), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  agentDir = join(tempDir, "agent");
  cwd = join(tempDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ProjectTrustStore", () => {
  it("stores decisions and inherits from parent directories", () => {
    const store = new ProjectTrustStore(agentDir);
    const parentDir = join(tempDir, "trusted-parent");
    const childDir = join(parentDir, "project");
    mkdirSync(childDir, { recursive: true });

    expect(store.get(childDir)).toBeNull();
    store.set(parentDir, true);
    expect(store.get(childDir)).toBe(true);
    expect(store.getEntry(childDir)).toEqual({ path: parentDir, decision: true });
    store.set(childDir, false);
    expect(store.get(childDir)).toBe(false);
    store.set(childDir, null);
    expect(store.get(childDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8"))).toEqual({
      [parentDir]: true,
    });
  });

  it("rejects a malformed store instead of guessing", () => {
    writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [cwd]: "yes" }));
    expect(() => new ProjectTrustStore(agentDir).get(cwd)).toThrow("must be true, false, or null");
    writeFileSync(join(agentDir, "trust.json"), "[]");
    expect(() => new ProjectTrustStore(agentDir).get(cwd)).toThrow("expected an object");
  });

  it("keeps every update when several stores write at once", async () => {
    const dirs = Array.from({ length: 8 }, (_, index) => join(tempDir, `p${index}`));
    await Promise.all(
      dirs.map(async (dir, index) => {
        mkdirSync(dir);
        new ProjectTrustStore(agentDir).set(dir, index % 2 === 0);
      }),
    );
    const store = new ProjectTrustStore(agentDir);
    expect(dirs.map((dir) => store.get(dir))).toEqual(dirs.map((_, index) => index % 2 === 0));
  });

  // Regression test for https://github.com/earendil-works/pi/issues/10488
  it("matches saved decisions regardless of casing on Windows", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const projectDir = join(tempDir, "Project-Mixed");
    mkdirSync(projectDir, { recursive: true });
    const store = new ProjectTrustStore(agentDir);
    store.set(projectDir, true);
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(store.get(projectDir.toLowerCase())).toBe(true);
      store.set(projectDir.toLowerCase(), false);
      const saved = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8")) as Record<
        string,
        boolean
      >;
      expect(Object.values(saved)).toEqual([false]);
      expect(store.get(projectDir)).toBe(false);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });
});

describe("trust-requiring project resources", () => {
  it("detects project settings, extensions, skills and prompts, not context files", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "# instructions\n");
    expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
    for (const entry of ["settings.json", "extensions", "skills", "prompts", "SYSTEM.md"]) {
      const path = join(cwd, ".generic-ai", entry);
      if (entry.includes(".")) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "{}");
      } else {
        mkdirSync(path, { recursive: true });
      }
      expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
      rmSync(join(cwd, ".generic-ai"), { recursive: true, force: true });
    }
  });

  it("offers trust, trust parent, and do-not-trust choices", () => {
    const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
    expect(options.map((option) => option.label)).toEqual([
      "Trust",
      `Trust parent folder (${tempDir})`,
      "Trust (this session only)",
      "Do not trust",
      "Do not trust (this session only)",
    ]);
    expect(options[1]?.updates).toEqual([
      { path: tempDir, decision: true },
      { path: cwd, decision: null },
    ]);
    expect(getProjectTrustOptions(cwd).map((option) => option.label)).toHaveLength(3);
  });
});

describe("resolveProjectTrusted", () => {
  // Regression tests for https://github.com/earendil-works/pi/issues/10947
  it("honors a saved decision before auto-trust for projects without trust-requiring resources", async () => {
    writeFileSync(join(cwd, "AGENTS.md"), "# untrusted\n");
    const store = new ProjectTrustStore(agentDir);
    const resolve = () => resolveProjectTrusted({ cwd, store });

    expect(await resolve()).toBe(true);
    store.set(cwd, false);
    expect(await resolve()).toBe(false);
    store.set(cwd, true);
    expect(await resolve()).toBe(true);
  });

  it("uses the override, the saved decision, the default, then asks", async () => {
    mkdirSync(join(cwd, ".generic-ai", "extensions"), { recursive: true });
    const store = new ProjectTrustStore(agentDir);

    expect(await resolveProjectTrusted({ cwd, store, trustOverride: true })).toBe(true);
    // Undecided and nobody to ask: not trusted.
    expect(await resolveProjectTrusted({ cwd, store })).toBe(false);
    expect(await resolveProjectTrusted({ cwd, store, defaultProjectTrust: "always" })).toBe(true);
    expect(await resolveProjectTrusted({ cwd, store, defaultProjectTrust: "never" })).toBe(false);

    const prompts: string[] = [];
    const trusted = await resolveProjectTrusted({
      cwd,
      store,
      ask: (prompt, options) => {
        prompts.push(prompt);
        return options.find((option) => option.label === "Trust (this session only)");
      },
    });
    expect(trusted).toBe(true);
    expect(prompts[0]).toContain(`Trust project folder?\n${cwd}`);
    // Session-only saves nothing.
    expect(store.get(cwd)).toBeNull();

    await resolveProjectTrusted({
      cwd,
      store,
      ask: (_prompt, options) => options.find((option) => option.label === "Do not trust"),
    });
    expect(store.get(cwd)).toBe(false);
    // The saved decision now wins over the default.
    expect(await resolveProjectTrusted({ cwd, store, defaultProjectTrust: "always" })).toBe(false);
    expect(await resolveProjectTrusted({ cwd, store, ask: () => undefined })).toBe(false);
  });
});

describe("untrusted project resources", () => {
  it("leaves project skills and prompts out when includeProjectResources is false", () => {
    mkdirSync(join(cwd, ".generic-ai", "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(cwd, ".generic-ai", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the app.\n---\nRun it.\n",
    );
    mkdirSync(join(cwd, ".generic-ai", "prompts"), { recursive: true });
    writeFileSync(join(cwd, ".generic-ai", "prompts", "review.md"), "Review $1\n");

    const skills = (includeProjectResources?: boolean) =>
      loadSkills({
        cwd,
        agentDir,
        skillPaths: [],
        includeDefaults: true,
        includeProjectResources,
      }).skills.map((skill) => skill.name);
    const prompts = (includeProjectResources?: boolean) =>
      loadPromptTemplates({
        cwd,
        agentDir,
        promptPaths: [],
        includeDefaults: true,
        includeProjectResources,
      }).templates.map((template) => template.name);

    expect(skills()).toEqual(["deploy"]);
    expect(skills(false)).toEqual([]);
    expect(prompts()).toEqual(["review"]);
    expect(prompts(false)).toEqual([]);
  });
});
