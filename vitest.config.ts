import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageAliases = [
  "core",
  "sdk",
  "observability",
  "preset-starter-hono",
  "plugin-config-yaml",
  "plugin-workspace-fs",
  "plugin-storage-memory",
  "plugin-tools-terminal",
  "plugin-tools-terminal-sandbox",
  "plugin-tools-files",
  "plugin-repo-map",
  "plugin-lsp",
  "plugin-mcp",
  "plugin-agent-skills",
  "plugin-delegation",
  "plugin-interaction",
  "plugin-logging-otel",
  "plugin-messaging",
  "plugin-memory-files",
  "plugin-output-default",
  "plugin-queue-memory",
  "plugin-hono",
  "plugin-storage-sqlite",
  "plugin-tools-web",
  "plugin-web-ui",
];

export default defineConfig({
  resolve: {
    alias: packageAliases
      .map((packageName) => ({
        find: new RegExp(`^@generic-ai/${packageName}$`),
        replacement: resolve(__dirname, `packages/${packageName}/src/index.ts`),
      }))
      .concat([
        {
          find: /^@generic-ai\/sdk\/pi$/,
          replacement: resolve(__dirname, "packages/sdk/src/pi/index.ts"),
        },
        {
          find: /^@generic-ai\/plugin-web-ui\/client$/,
          replacement: resolve(__dirname, "packages/plugin-web-ui/src/client.tsx"),
        },
        {
          find: /^@generic-ai\/plugin-web-ui\/server$/,
          replacement: resolve(__dirname, "packages/plugin-web-ui/src/server.ts"),
        },
        {
          find: /^@generic-ai\/plugin-web-ui\/agent-tools$/,
          replacement: resolve(__dirname, "packages/plugin-web-ui/src/agent-tools.ts"),
        },
      ]),
  },
  test: {
    include: [
      "packages/*/src/**/*.{test,spec}.{ts,tsx}",
      "packages/*/test/**/*.{test,spec}.{ts,tsx}",
      "examples/*/src/**/*.{test,spec}.{ts,tsx}",
      "examples/*/test/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.{test,spec}.{ts,tsx}",
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
