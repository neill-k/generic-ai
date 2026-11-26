import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: /^@generic-ai\/ai$/, replacement: resolve(__dirname, "../ai/src/index.ts") }],
  },
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    environment: "node",
    passWithNoTests: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
