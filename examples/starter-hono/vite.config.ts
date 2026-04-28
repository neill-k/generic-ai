import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "ui",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(packageDir, "ui", "src"),
      "@generic-ai/plugin-web-ui/client": resolve(
        packageDir,
        "../../packages/plugin-web-ui/src/client.tsx",
      ),
    },
  },
  server: {
    proxy: {
      "/console/api": "http://127.0.0.1:3000",
      "/starter": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
  },
});
