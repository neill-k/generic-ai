---
"@generic-ai/sdk": patch
"@generic-ai/core": patch
---

Let sealed goals decide when a topology is done. The verifier loop can check goal validators before or instead of its critic (`config.acceptance`), the topology runner executes `validate_goal` actions and gates every protocol's success on the goal being COMPLETE, and actors see the goal's definition of done in their prompts.
