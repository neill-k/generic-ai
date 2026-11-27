---
"@generic-ai/resources": minor
"@generic-ai/extensions": minor
"@generic-ai/core": minor
---

Add pi's project trust. `ProjectTrustStore` saves per-directory decisions in `<agentDir>/trust.json` with parent inheritance, and `resolveProjectTrusted` decides from an override, the saved decision, a default (`always`, `never`, `ask`) and an `ask` callback offering pi's choices. Untrusted projects' own skills, prompts and extensions stay out through `includeProjectResources` on `loadSkills` and `loadPromptTemplates`, `includeProjectExtensions` on `discoverExtensions`, and `native.extensions.projectTrust` in the harness, which also records a `project_trust` event.
