import { defineConfig } from "vitest/config";

export default defineConfig({
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
