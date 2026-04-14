import { describe, expect, it } from "vitest";
import { PluginSchemaRegistry, type ZodIssueLike, type ZodSchemaLike } from "./registry.js";
import {
  assertValidConfigAtStartup,
  ConfigValidationError,
  formatConfigValidationDiagnostics,
  validateConfigAtStartup,
} from "./validation.js";

describe("validateConfigAtStartup", () => {
  it("passes valid plugin config for registered namespaces", () => {
    const registry = new PluginSchemaRegistry();
    registry.register({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      namespace: "storage",
      schema: objectSchema({
        enabled: "boolean",
      }),
      source: "plugins/storage.ts",
    });

    const result = validateConfigAtStartup(
      {
        plugins: {
          storage: {
            enabled: true,
          },
        },
      },
      registry,
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("returns provenance-rich diagnostics when schema validation fails", () => {
    const registry = new PluginSchemaRegistry();
    registry.register({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      namespace: "storage",
      schema: objectSchema({
        enabled: "boolean",
      }),
      source: "plugins/storage.ts",
    });

    const result = validateConfigAtStartup(
      {
        plugins: {
          storage: {
            enabled: "true",
          },
        },
      },
      registry,
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_VALIDATION_FAILED",
      namespace: "storage",
      path: "$.plugins.storage.enabled",
      pluginIds: ["@generic-ai/plugin-storage-sqlite"],
      issueCode: "invalid_type",
    });
    expect(result.diagnostics[0]?.provenance[0]?.source).toBe("plugins/storage.ts");
  });

  it("blocks unknown namespaces by default", () => {
    const registry = new PluginSchemaRegistry();
    registry.register({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      namespace: "storage",
      schema: objectSchema({
        enabled: "boolean",
      }),
    });

    const result = validateConfigAtStartup(
      {
        plugins: {
          storage: {
            enabled: true,
          },
          mystery: {
            anything: true,
          },
        },
      },
      registry,
    );

    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "UNKNOWN_PLUGIN_NAMESPACE"),
    ).toBe(true);
  });

  it("supports allowing unknown namespaces when requested", () => {
    const registry = new PluginSchemaRegistry();
    registry.register({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      namespace: "storage",
      schema: objectSchema({
        enabled: "boolean",
      }),
    });

    const result = validateConfigAtStartup(
      {
        plugins: {
          mystery: {
            anything: true,
          },
        },
      },
      registry,
      {
        rejectUnknownPluginNamespaces: false,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("throws ConfigValidationError with formatted diagnostic details", () => {
    const registry = new PluginSchemaRegistry();
    registry.register({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      namespace: "storage",
      schema: objectSchema({
        enabled: "boolean",
      }),
      source: "plugins/storage.ts",
    });

    expect(() =>
      assertValidConfigAtStartup(
        {
          plugins: {
            storage: {
              enabled: "bad",
            },
          },
        },
        registry,
      ),
    ).toThrow(ConfigValidationError);

    const result = validateConfigAtStartup(
      {
        plugins: {
          storage: {
            enabled: "bad",
          },
        },
      },
      registry,
    );
    const rendered = formatConfigValidationDiagnostics(result.diagnostics);
    expect(rendered).toContain("$.plugins.storage.enabled");
    expect(rendered).toContain("@generic-ai/plugin-storage-sqlite");
    expect(rendered).toContain("plugins/storage.ts");
  });
});

function objectSchema(spec: Record<string, "boolean" | "string">): ZodSchemaLike<unknown> {
  return {
    safeParse(input: unknown) {
      if (!isRecord(input)) {
        return {
          success: false,
          error: {
            issues: [
              {
                code: "invalid_type",
                message: "Expected object.",
                path: [],
              },
            ],
          },
        };
      }

      const issues: ZodIssueLike[] = [];
      for (const [fieldName, expectedType] of Object.entries(spec)) {
        if (!(fieldName in input)) {
          issues.push({
            code: "missing_required",
            message: `Missing required field "${fieldName}".`,
            path: [fieldName],
          });
          continue;
        }

        if (typeof input[fieldName] !== expectedType) {
          issues.push({
            code: "invalid_type",
            message: `Expected "${fieldName}" to be ${expectedType}.`,
            path: [fieldName],
          });
        }
      }

      if (issues.length > 0) {
        return {
          success: false,
          error: {
            issues,
          },
        };
      }

      return {
        success: true,
        data: input,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
