---
"@generic-ai/subagents": minor
---

Agents can observe their family the way Prime Agent's `agent_observe` does. New tools `observe_agents`, `get_agent` and `recent_agent_messages` (and `AgentNode.observeAgents`, `observeAgent`, `recentMessages`) report each parent, sibling and child's status, live activity (model, tool, busy, idle), message and inbox counts, task status and progress note, and bounded previews of its latest messages. Hosts can pause, resume and clear agent messages to one agent with `pauseMessages`, `resumeMessages` and `clearMessages`. Child sessions may expose `messages()` and `activity()`; `AgentChildSession` does.
