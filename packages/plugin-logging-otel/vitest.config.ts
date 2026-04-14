import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
    reporters: ["default"],
    watch: false,
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});

