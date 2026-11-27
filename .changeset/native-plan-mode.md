---
"@generic-ai/extensions": minor
---

Add pi's plan mode as `createPlanMode()`. While planning, `edit` and `write` are refused and bash must pass a read-only allowlist, and the model is asked for a numbered plan. The steps are extracted when the run ends, `execute()` returns the prompt that runs the plan with full access, and `[DONE:n]` markers track progress. `/plan`, `/plan on|off` and `/plan execute` control it from a prompt. The helpers `isSafeCommand`, `extractTodoItems`, `extractDoneSteps`, `markCompletedSteps`, `cleanStepText` and `allStepsComplete` are exported.
