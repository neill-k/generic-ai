import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

/**
 * Serves the owner's app.
 *
 * `/` is the app built from `apps/generic-corp/web` (Preact, bundled by Vite into
 * `dist/web`, decision 53). The page holds no data: it calls the authenticated API, and an
 * unauthenticated browser is sent to the owner login page.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where `vite build` writes the app. From `src/` (tests) and `dist/` alike it is `dist/web`. */
export const DEFAULT_WEB_DIR = path.resolve(HERE, "..", "dist", "web");

const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
});

/** Built asset names: Vite's `name-hash.ext`, never a path. */
const WEB_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const DASHBOARD_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    // Bars and indentation use style attributes; no inline scripts are allowed.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export interface DashboardRoutesOptions {
  /** The built app (`index.html` plus `app/`). */
  readonly webDir?: string;
}

export function createDashboardRoutes(options: DashboardRoutesOptions = {}): Hono {
  const webDir = options.webDir ?? DEFAULT_WEB_DIR;
  const app = new Hono();
  const cache = new Map<string, Buffer>();

  async function load(file: string): Promise<Buffer | undefined> {
    const cached = cache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const contents = await readFile(file);
      cache.set(file, contents);
      return contents;
    } catch {
      return undefined;
    }
  }

  const htmlResponse = (html: Buffer) =>
    new Response(new Uint8Array(html), {
      headers: {
        ...DASHBOARD_SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });

  const page = async () => {
    const html = await load(path.join(webDir, "index.html"));
    if (html === undefined) {
      return new Response(
        "The app has not been built. Run `npm run build -w @generic-ai/app-generic-corp`.",
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return htmlResponse(html);
  };

  app.get("/", page);
  app.get("/index.html", page);
  app.get("/app/:file", async (c) => {
    const file = c.req.param("file");
    const contentType = WEB_CONTENT_TYPES[path.extname(file)];
    if (!WEB_ASSET.test(file) || contentType === undefined) {
      return c.notFound();
    }
    const contents = await load(path.join(webDir, "app", file));
    if (contents === undefined) {
      return c.notFound();
    }
    return new Response(new Uint8Array(contents), {
      headers: {
        ...DASHBOARD_SECURITY_HEADERS,
        "content-type": contentType,
        // Names carry a content hash, so a file never changes under its name.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  return app;
}
