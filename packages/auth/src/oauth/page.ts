function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(title: string, heading: string, message: string, details?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; }
  main { max-width: 520px; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  p { margin: 0; line-height: 1.6; opacity: 0.8; }
  pre { margin-top: 16px; white-space: pre-wrap; word-break: break-word; font-size: 13px; opacity: 0.7; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
${details ? `<pre>${escapeHtml(details)}</pre>` : ""}
</main>
</body>
</html>`;
}

/** Page shown in the browser after a successful sign-in. */
export function oauthSuccessHtml(message: string): string {
  return renderPage("Signed in", "Authentication successful", message);
}

/** Page shown in the browser when a sign-in fails. Text is escaped. */
export function oauthErrorHtml(message: string, details?: string): string {
  return renderPage("Sign-in failed", "Authentication failed", message, details);
}
