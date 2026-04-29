#!/usr/bin/env bash
set -euo pipefail

npm run -w @generic-ai/example-terminal-bench build
npm run -w @generic-ai/example-terminal-bench terminal-bench:run -- --profile validation "$@"
