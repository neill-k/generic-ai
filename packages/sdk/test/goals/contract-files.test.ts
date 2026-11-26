import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  goalJudgmentJsonSchema,
  goalSpecJsonSchema,
  goalValidationReportJsonSchema,
} from "../../src/goals/index.js";

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/goals");
const update = process.env["GENERIC_AI_UPDATE_CONTRACTS"] === "1";

describe("frozen goal contract files", () => {
  it.each([
    ["goal-spec.schema.json", goalSpecJsonSchema],
    ["goal-judgment.schema.json", goalJudgmentJsonSchema],
    ["goal-validation-report.schema.json", goalValidationReportJsonSchema],
  ])("%s matches the SDK schema", (file, schema) => {
    const path = join(contractsDir, file);
    const expected = `${JSON.stringify(schema, null, 2)}\n`;
    if (update) {
      writeFileSync(path, expected);
    }
    expect(readFileSync(path, "utf8")).toBe(expected);
  });
});
