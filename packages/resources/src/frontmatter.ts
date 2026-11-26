// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/utils/frontmatter.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { parse } from "yaml";

export interface ParsedFrontmatter<T extends Record<string, unknown>> {
  readonly frontmatter: T;
  readonly body: string;
}

export function stripBom(content: string): string {
  return content.startsWith("﻿") ? content.slice(1) : content;
}

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
  const normalized = normalizeNewlines(stripBom(content));

  if (!normalized.startsWith("---")) {
    return { yamlString: null, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { yamlString: null, body: normalized };
  }

  return {
    yamlString: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trim(),
  };
};

/** Split a markdown file into its YAML frontmatter and body. Throws when the YAML is invalid. */
export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> {
  const { yamlString, body } = extractFrontmatter(content);
  if (!yamlString) {
    return { frontmatter: {} as T, body };
  }
  const parsed: unknown = parse(yamlString);
  return { frontmatter: (parsed ?? {}) as T, body };
}

export function stripFrontmatter(content: string): string {
  return parseFrontmatter(content).body;
}
