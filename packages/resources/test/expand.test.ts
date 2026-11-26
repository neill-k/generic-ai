import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseFrontmatter, stripFrontmatter } from "../src/frontmatter.js";
import { expandSkillCommand, loadSkillsFromDir } from "../src/skills.js";

const root = mkdtempSync(join(tmpdir(), "generic-ai-resources-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseFrontmatter", () => {
  it("splits YAML frontmatter from the body and strips a BOM and CRLF", () => {
    const parsed = parseFrontmatter("﻿---\r\nname: demo\r\ncount: 2\r\n---\r\nBody text\r\n");
    expect(parsed.frontmatter).toEqual({ name: "demo", count: 2 });
    expect(parsed.body).toBe("Body text");
  });

  it("returns the whole text as the body when there is no frontmatter", () => {
    expect(parseFrontmatter("Just text")).toEqual({ frontmatter: {}, body: "Just text" });
    expect(stripFrontmatter("---\nunterminated")).toBe("---\nunterminated");
  });

  it("throws on invalid YAML", () => {
    expect(() => parseFrontmatter("---\nname: [unclosed\n---\nbody")).toThrow();
  });
});

describe("expandSkillCommand", () => {
  const skillDir = join(root, "skills", "triage");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: triage\ndescription: Triage an incoming issue\n---\n\nLabel the issue, then assign it.\n",
  );
  const { skills } = loadSkillsFromDir({ dir: join(root, "skills"), source: "path" });

  it("replaces the command with the skill body and keeps the arguments", () => {
    const expanded = expandSkillCommand("/skill:triage issue 42", skills);
    expect(expanded).toBe(
      `<skill name="triage" location="${join(skillDir, "SKILL.md")}">\nReferences are relative to ${skillDir}.\n\nLabel the issue, then assign it.\n</skill>\n\nissue 42`,
    );
  });

  it("expands a command without arguments", () => {
    expect(expandSkillCommand("/skill:triage", skills)).toMatch(/<\/skill>$/);
  });

  it("leaves unknown skills and other text unchanged", () => {
    expect(expandSkillCommand("/skill:missing do it", skills)).toBe("/skill:missing do it");
    expect(expandSkillCommand("plain text", skills)).toBe("plain text");
  });
});
