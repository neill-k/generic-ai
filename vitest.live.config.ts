// Manual live runs only: `npm run test:live -- <file>`. Never used by `npm test` or CI.
// Unlike vitest.config.ts it runs *.live.test.ts files and keeps provider keys in the environment.
import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.ts";

export default mergeConfig(
  { ...base, test: { ...base.test, include: [], exclude: [], setupFiles: [] } },
  defineConfig({
    test: {
      include: ["**/*.live.test.{ts,tsx}"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      testTimeout: 180_000,
    },
  }),
);
