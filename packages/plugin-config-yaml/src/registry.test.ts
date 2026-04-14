import { describe, expect, it } from "vitest";
import {
  deriveNamespaceFromPluginId,
  PluginSchemaRegistry,
  SchemaRegistryError,
  type ZodComposableSchemaLike,
  type ZodIssueLike,
  type ZodSchemaLike,
} from "./registry.js";

describe("PluginSchemaRegistry", () => {
  it("derives deterministic namespaces from plugin package ids", () => {
    expect(deriveNamespaceFromPluginId("@generic-ai/plugin-storage-sqlite")).toBe("storage-sqlite");
    expect(deriveNamespaceFromPluginId("plugin-tools-terminal")).toBe("tools-terminal");
  });

  it("normalizes explicit namespaces during registration", () => {
    const registry = new PluginSchemaRegistry();
    registry.register({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      namespace: " Storage_SQLite ",
      schema: passSchema(),
    });

    const [registered] = registry.list();
    expect(registered?.namespace).toBe("storage-sqlite");
  });

  it("composes multiple fragments in the same namespace", () => {
    const registry = new PluginSchemaRegistry();
    registry.register([
      {
        pluginId: "@generic-ai/plugin-storage-sqlite",
        namespace: "storage",
        schema: requiredFieldSchema("driver", "string"),
      },
      {
        pluginId: "@generic-ai/plugin-storage-sqlite",
        namespace: "storage",
        schema: requiredFieldSchema("enabled", "boolean"),
      },
    ]);

    const composed = registry.compose();
    expect(composed.namespaces).toHaveLength(1);
    expect(composed.namespaces[0]?.namespace).toBe("storage");

    const valid = composed.namespaces[0]?.schema.safeParse({ driver: "sqlite", enabled: true });
    expect(valid?.success).toBe(true);

    const invalid = composed.namespaces[0]?.schema.safeParse({ driver: "sqlite" });
    expect(invalid?.success).toBe(false);
  });

  it("throws INVALID_FRAGMENT when schema does not expose safeParse", () => {
    const registry = new PluginSchemaRegistry();

    expect(() =>
      registry.register({
        pluginId: "@generic-ai/plugin-storage-sqlite",
        schema: {} as ZodSchemaLike<unknown>,
      }),
    ).toThrow(SchemaRegistryError);

    try {
      registry.register({
        pluginId: "@generic-ai/plugin-storage-sqlite",
        schema: {} as ZodSchemaLike<unknown>,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaRegistryError);
      expect((error as SchemaRegistryError).code).toBe("INVALID_FRAGMENT");
    }
  });

  it("throws SCHEMA_CONFLICT when merge composition fails", () => {
    const registry = new PluginSchemaRegistry();
    registry.register([
      {
        pluginId: "@generic-ai/plugin-storage-sqlite",
        namespace: "storage",
        schema: mergeSchemaThatThrows(),
      },
      {
        pluginId: "@generic-ai/plugin-storage-memory",
        namespace: "storage",
        schema: mergeSchemaPassthrough(),
      },
    ]);

    expect(() => registry.compose()).toThrow(SchemaRegistryError);

    try {
      registry.compose();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaRegistryError);
      expect((error as SchemaRegistryError).code).toBe("SCHEMA_CONFLICT");
    }
  });
});

function passSchema(): ZodSchemaLike<unknown> {
  return {
    safeParse(input: unknown) {
      return {
        success: true,
        data: input,
      };
    },
  };
}

function requiredFieldSchema(fieldName: string, expectedType: "boolean" | "string"): ZodSchemaLike<unknown> {
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
      if (!(fieldName in input)) {
        issues.push({
          code: "missing_required",
          message: `Missing required field "${fieldName}".`,
          path: [fieldName],
        });
      } else if (typeof input[fieldName] !== expectedType) {
        issues.push({
          code: "invalid_type",
          message: `Expected "${fieldName}" to be ${expectedType}.`,
          path: [fieldName],
        });
      }

      if (issues.length > 0) {
        return {
          success: false,
          error: { issues },
        };
      }

      return {
        success: true,
        data: input,
      };
    },
  };
}

function mergeSchemaThatThrows(): ZodComposableSchemaLike<unknown> {
  return {
    safeParse(input: unknown) {
      return {
        success: true,
        data: input,
      };
    },
    merge() {
      throw new Error("Cannot merge schema fragments");
    },
  };
}

function mergeSchemaPassthrough(): ZodComposableSchemaLike<unknown> {
  return {
    safeParse(input: unknown) {
      return {
        success: true,
        data: input,
      };
    },
    merge(other: ZodComposableSchemaLike<unknown>) {
      return other;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
