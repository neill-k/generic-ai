import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@generic-ai\/core$/,
        replacement: resolve(__dirname, "packages/core/src/index.ts"),
      },
      {
        find: /^@generic-ai\/sdk$/,
        replacement: resolve(__dirname, "packages/sdk/src/index.ts"),
      },
      {
        find: /^@generic-ai\/preset-starter-hono$/,
        replacement: resolve(__dirname, "packages/preset-starter-hono/src/index.ts"),
      },
    ],
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
