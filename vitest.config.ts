import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageAliases = [
  "ai",
  "agent",
  "tools",
  "session",
  "resources",
  "extensions",
  "subagents",
  "autonomy",
  "continual",
  "auth",
  "core",
  "sdk",
  "observability",
  "preset-starter-hono",
  "plugin-config-yaml",
  "plugin-workspace-fs",
  "plugin-storage-memory",
  "plugin-tools-terminal",
  "plugin-tools-terminal-sandbox",
  "plugin-tools-documents",
  "plugin-tools-files",
  "plugin-repo-map",
  "plugin-lsp",
  "plugin-mcp",
  "plugin-agent-skills",
  "plugin-delegation",
  "plugin-approvals",
  "plugin-interaction",
  "plugin-logging-otel",
  "plugin-messaging",
  "plugin-memory-files",
  "plugin-output-default",
  "plugin-queue-memory",
  "plugin-hono",
  "plugin-auth-identity",
  "plugin-secrets",
  "plugin-storage-sqlite",
  "plugin-storage-postgres",
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
          find: /^@generic-ai\/sdk\/testing$/,
          replacement: resolve(__dirname, "packages/sdk/src/testing/index.ts"),
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
      "apps/*/src/**/*.{test,spec}.{ts,tsx}",
      "apps/*/test/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.{test,spec}.{ts,tsx}",
    ],
    // *.live.test.ts files call real models and never run in `npm test` or CI; see
    // vitest.live.config.ts. The setup file strips provider keys so nothing else can either.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.live.test.{ts,tsx}",
    ],
    setupFiles: [resolve(__dirname, "scripts/vitest-no-live-providers.mjs")],
    passWithNoTests: true,
    reporters: ["default"],
    watch: false,
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
