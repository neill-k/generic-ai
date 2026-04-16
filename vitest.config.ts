import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageAliases = [
  "core",
  "sdk",
  "preset-starter-hono",
  "plugin-config-yaml",
  "plugin-workspace-fs",
  "plugin-storage-memory",
  "plugin-tools-terminal",
  "plugin-tools-files",
  "plugin-mcp",
  "plugin-agent-skills",
  "plugin-delegation",
  "plugin-messaging",
  "plugin-memory-files",
  "plugin-output-default",
  "plugin-hono",
];

export default defineConfig({
  resolve: {
    alias: packageAliases.map((packageName) => ({
      find: new RegExp(`^@generic-ai/${packageName}$`),
      replacement: resolve(__dirname, `packages/${packageName}/src/index.ts`),
    })),
  },
  test: {
    include: [
      "packages/*/src/**/*.{test,spec}.{ts,tsx}",
      "packages/*/test/**/*.{test,spec}.{ts,tsx}",
      "examples/*/src/**/*.{test,spec}.{ts,tsx}",
      "examples/*/test/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.turbo/**", "**/coverage/**"],
    passWithNoTests: true,
    reporters: ["default"],
    watch: false,
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
