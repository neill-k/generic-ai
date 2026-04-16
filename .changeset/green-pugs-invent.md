---
"@generic-ai/preset-starter-hono": patch
---

Add sandbox-aware starter preset wiring so bootstrap can switch the terminal slot between unrestricted and Docker-backed modes. Production now defaults to sandbox mode, Docker availability is checked during bootstrap, and fallback behavior is configurable via environment variables.
