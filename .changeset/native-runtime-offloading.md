---
"@generic-ai/tools": minor
"@generic-ai/core": minor
---

Add offloading to native sessions (R25). Long tool results are saved to output files and the model gets a preview and the path (`withOffload`, on by default, `offload: false` turns it off). `toolBatch` gives the agent `tool_batch` for several independent calls in one step. `harvest` saves the scripts a run wrote when it passes its goal's validators, and `promoteScriptToSkill` turns one into a skill with documented flags.
