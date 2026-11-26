---
"@generic-ai/sdk": minor
---

Add goal contracts and a validator runner: `GoalSpec` with a definition of done plus numeric, rubric (judge), trace, output-schema, and host-check validators; `sealGoal` to freeze and fingerprint goals so agents cannot edit their validators; `runGoalValidators` returning `COMPLETE`/`INCOMPLETE` with actionable feedback; and JSON Schemas for goal specs, judge output, and validation reports.
