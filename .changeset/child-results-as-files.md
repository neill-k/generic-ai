---
"@generic-ai/plugin-delegation": patch
---

`createDelegationCascade({ saveChildResult })` saves a finished child's whole result where the parent's tools can read it. A result longer than `childResultPromptChars` then reaches the parent as a 2,000-character excerpt plus the file's path instead of being cut off.
