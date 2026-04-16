# @generic-ai/plugin-tools-web

Configurable web fetch and search tools for Generic AI.

This package follows the same package-level shape as the other tool plugins: it exposes a named capability plugin, a workspace-anchored root, and `pi`-compatible tool objects you can hand to your own runtime or extension wiring.

## What it provides

- `web_fetch` for HTTP(S) retrieval with timeout handling, manual redirect handling, content-type detection, and HTML-to-text conversion
- `web_search` for provider-backed search with a vendor-neutral provider interface
- shared hostname allow/block rules applied to both direct fetches and provider search results

## Example

```ts
import { createWebToolsPlugin } from "@generic-ai/plugin-tools-web";

const webTools = createWebToolsPlugin({
  root: process.cwd(),
  allowedHosts: ["docs.example.com", "*.example.dev"],
  blockedHosts: ["internal.example.com"],
  searchProvider: {
    name: "example-search",
    async search({ query, limit }) {
      return [
        {
          title: `Result for ${query}`,
          url: "https://docs.example.com/start",
          snippet: "Example search provider response.",
        },
      ].slice(0, limit);
    },
  },
});

const fetched = await webTools.fetch({ url: "https://docs.example.com/start" });
const searched = await webTools.search({ query: "generic ai", limit: 5 });
```

## Host policy rules

- `blockedHosts` always wins
- `allowedHosts` is optional; when omitted, any public HTTP(S) host is allowed unless blocked
- patterns are hostname-based and support exact matches (`docs.example.com`) plus wildcard subdomains (`*.example.com`)

## Planning baseline

- `docs/planning/README.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
