import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: ["tools"].map((name) => ({
      find: new RegExp(`^@generic-ai/${name}$`),
      replacement: resolve(__dirname, `../${name}/src/index.ts`),
    })),
  },
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    environment: "node",
    passWithNoTests: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
