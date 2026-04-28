import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPluginSchemaRegistry } from "./registry.js";
import {
  applyCanonicalConfigTransaction,
  getCanonicalConfigTransactionSnapshot,
  previewCanonicalConfigTransaction,
} from "./transactions.js";

async function seedConfig(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "generic-ai-config-transaction-"));
  await mkdir(join(root, ".generic-ai", "agents"), { recursive: true });
  await writeFile(
    join(root, ".generic-ai", "framework.yaml"),
    ["schemaVersion: v1", "name: Transaction fixture", "primaryAgent: starter"].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, ".generic-ai", "agents", "starter.yaml"),
    ["displayName: Starter", "model: gpt-5.5", "tools: []", "plugins: []"].join("\n"),
    "utf8",
  );
  return root;
}

describe("canonical config transactions", () => {
  it("previews filename-keyed YAML without writing files", async () => {
    const root = await seedConfig();
    const before = await readFile(join(root, ".generic-ai", "agents", "starter.yaml"), "utf8");
    const preview = await previewCanonicalConfigTransaction(root, {
      edits: [
        {
          action: "set",
          concern: "agent",
          key: "researcher",
          value: {
            id: "researcher",
            displayName: "Researcher",
            model: "gpt-5.5",
            tools: [],
            plugins: [],
          },
        },
      ],
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.plan.files[0]?.content).toContain("displayName: Researcher");
    expect(preview.plan.files[0]?.content).not.toContain("id:");
    expect(await readFile(join(root, ".generic-ai", "agents", "starter.yaml"), "utf8")).toBe(before);
  });

  it("applies edits atomically and verifies by resolving the canonical config", async () => {
    const root = await seedConfig();
    const snapshot = await getCanonicalConfigTransactionSnapshot(root);
    const applied = await applyCanonicalConfigTransaction(root, {
      expectedRevision: snapshot.revision,
      edits: [
        {
          action: "set",
          concern: "harness",
          key: "default",
          value: {
            displayName: "Default Harness",
            adapter: "pi",
            controller: "model-directed",
            model: "gpt-5.5",
            primaryAgent: "starter",
            policyProfile: "local-dev-full",
          },
        },
      ],
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.config.harnesses?.["default"]?.id).toBe("default");
    expect(await readFile(join(root, ".generic-ai", "harnesses", "default.yaml"), "utf8")).not.toContain("id:");
  });

  it("rejects stale revisions before writing", async () => {
    const root = await seedConfig();
    const rejected = await previewCanonicalConfigTransaction(root, {
      expectedRevision: "stale",
      edits: [
        {
          action: "set",
          concern: "agent",
          key: "planner",
          value: { displayName: "Planner", model: "gpt-5.5", tools: [], plugins: [] },
        },
      ],
    });

    expect(rejected.ok).toBe(false);
    if (rejected.ok) {
      return;
    }
    expect(rejected.failures[0]?.code).toBe("CONFIG_CONFLICT");
  });

  it("rolls back when post-write verification fails", async () => {
    const root = await seedConfig();
    await mkdir(join(root, ".generic-ai", "plugins"), { recursive: true });
    const registry = createPluginSchemaRegistry();
    const applied = await applyCanonicalConfigTransaction(root, {
      schemaSource: registry,
      rejectUnknownPluginNamespaces: true,
      edits: [
        {
          action: "set",
          concern: "plugin",
          key: "example",
          value: {
            config: { enabled: true },
          },
        },
      ],
    });

    expect(applied.ok).toBe(false);
    await expect(
      readFile(join(root, ".generic-ai", "plugins", "example.yaml"), "utf8"),
    ).rejects.toThrow();
  });
});
