#!/usr/bin/env node
import { runToolCallingSmoke } from "./adapter.js";

runToolCallingSmoke()
  .then(({ markdown }) => {
    process.stdout.write(markdown);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
