import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The owner's app (decision 53). Preact with JSX compiled by esbuild, so the only runtime
 * dependency is Preact itself. The server serves `dist/web/index.html` at `/` and the hashed
 * files under `/app/`.
 */
export default defineConfig({
  root: here,
  base: "/",
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    outDir: path.resolve(here, "..", "dist", "web"),
    emptyOutDir: true,
    assetsDir: "app",
    // The page's content security policy allows no inline scripts.
    modulePreload: { polyfill: false },
    target: "es2022",
    sourcemap: false,
  },
  server: {
    // `npm run dev:web` with the app server on 8787: API calls and live events go to it.
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/auth": "http://127.0.0.1:8787",
    },
  },
});
