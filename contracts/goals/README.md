# Goal Contracts

Frozen JSON Schemas for the goal contracts in `@generic-ai/sdk` (`src/goals/`).
They are generated from the SDK constants and checked by
`packages/sdk/test/goals/contract-files.test.ts`. To refresh them after an
intentional contract change, run:

```bash
GENERIC_AI_UPDATE_CONTRACTS=1 npx vitest run packages/sdk/test/goals/contract-files.test.ts
```

Artifacts:

- `goal-spec.schema.json` - `GoalSpec`: objective, definition of done, validators, protected paths.
- `goal-judgment.schema.json` - `GoalJudgment`: the structured output a rubric judge returns.
- `goal-validation-report.schema.json` - `GoalValidationReport`: the runner's `COMPLETE`/`INCOMPLETE` verdict.

See `docs/goals.md` for semantics.
