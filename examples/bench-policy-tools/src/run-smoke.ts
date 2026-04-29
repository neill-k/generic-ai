#!/usr/bin/env node
import { runPolicyToolsSmoke } from "./adapter.js";

runPolicyToolsSmoke()
  .then(({ markdown }) => {
    process.stdout.write(markdown);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
