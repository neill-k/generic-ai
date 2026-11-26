import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

/**
 * Serves the dashboard (roadmap R14): one HTML page plus a script and a
 * stylesheet from `apps/generic-corp/public`, with no build step. The page
 * holds no data; it calls the authenticated API, and an unauthenticated
 * browser is sent to the owner login page.
 */
export const DEFAULT_PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);

const ASSETS: Readonly<Record<string, string>> = Object.freeze({
  "app.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
});

export const DASHBOARD_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    // Bars and indentation use style attributes; no inline scripts are allowed.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export function createDashboardRoutes(options: { readonly publicDir?: string } = {}): Hono {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const app = new Hono();
  const cache = new Map<string, string>();

  async function load(file: string): Promise<string | undefined> {
    const cached = cache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const contents = await readFile(path.join(publicDir, file), "utf8");
      cache.set(file, contents);
      return contents;
    } catch {
      return undefined;
    }
  }

  const page = async () => {
    const html = await load("index.html");
    if (html === undefined) {
      return new Response("The dashboard files are missing from this build.", { status: 500 });
    }
    return new Response(html, {
      headers: {
        ...DASHBOARD_SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  };

  app.get("/", page);
  app.get("/index.html", page);
  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    const contentType = ASSETS[file];
    const contents = contentType === undefined ? undefined : await load(file);
    if (contentType === undefined || contents === undefined) {
      return c.notFound();
    }
    return new Response(contents, {
      headers: {
        ...DASHBOARD_SECURITY_HEADERS,
        "content-type": contentType,
        "cache-control": "no-cache",
      },
    });
  });
  return app;
}
