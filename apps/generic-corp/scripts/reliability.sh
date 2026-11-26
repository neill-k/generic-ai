#!/usr/bin/env bash
# Reliability gate (R19), by hand only: the live template goal evals on real models, with the
# provider key read from your environment. Automated runs never call a real model, so this
# refuses to run in CI and no workflow calls it. The key never goes to GitHub.
#
#   export ANTHROPIC_API_KEY=...            # required
#   export BRAVE_API_KEY=...                # optional, or TAVILY_API_KEY; research goals need one
#   npm run reliability -w @generic-ai/app-generic-corp              # quick run (default)
#   npm run reliability -w @generic-ai/app-generic-corp -- --full    # the real gate
#
# Modes:
#   quick (default)  one attempt per goal, CEO on Sonnet 5.5, VPs and ICs on Haiku 5.5, judge
#                    on each template's own VP model, capped at $5 and 5M tokens. Tells you the
#                    cascade, tools and validators work on real models, cheaply.
#   --full           the templates' own models, each suite's attempt count (5) for pass^k,
#                    capped at $50 and 40M tokens. This is the gate a release should pass.
#
# Options (after --):
#   --full               see above
#   --docker             build the production image and run inside it (no local Node needed)
#   --template <id>      one template (repeatable); default every template
#   --trials <n>         attempts per goal, overriding the mode's
#   --max-usd <n>        dollar cap for the whole run, judge included
#   --max-tokens <n>     token cap for the whole run (cache reads count)
#   --out <dir>          report folder; default ./reliability-report
#   --no-build           skip the build (local mode only)
#   anything else is passed to the eval CLI as is (see: npm run evals -w @generic-ai/app-generic-corp -- --help)
#
# Exit codes: 0 every gate passed, 1 a gate failed, 2 bad arguments, 3 no provider key,
# 4 refused because it is running in CI.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

mode=quick
docker=false
build=true
out="reliability-report"
trials=""
max_usd=""
max_tokens=""
extra=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --full) mode=full ;;
    --quick) mode=quick ;;
    --docker) docker=true ;;
    --no-build) build=false ;;
    --out) out="$2"; shift ;;
    --trials) trials="$2"; shift ;;
    --max-usd) max_usd="$2"; shift ;;
    --max-tokens) max_tokens="$2"; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) extra+=("$1") ;;
  esac
  shift
done

if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${CI:-}" = "true" ]; then
  echo "Live evals call real models and only run by hand, never in CI. Nothing was run." >&2
  exit 4
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo "Set ANTHROPIC_API_KEY in your environment first. Nothing was run and nothing was spent." >&2
  exit 3
fi

args=(--live)
if [ "$mode" = quick ]; then
  args+=(--economy --trials "${trials:-1}" --max-usd "${max_usd:-5}" --max-tokens "${max_tokens:-5000000}")
else
  [ -n "$trials" ] && args+=(--trials "$trials")
  args+=(--max-usd "${max_usd:-50}" --max-tokens "${max_tokens:-40000000}")
fi
args+=("${extra[@]+"${extra[@]}"}")

echo "Reliability gate, $mode mode: ${args[*]}"
mkdir -p "$out"

if [ "$docker" = true ]; then
  image="generic-corp:reliability"
  docker build -f apps/generic-corp/Dockerfile --build-arg INSTALL_BROWSER=true -t "$image" .
  out_abs="$(cd "$out" && pwd)"
  # Keys pass by name only (-e NAME), so their values never appear on the command line.
  docker run --rm \
    -e ANTHROPIC_API_KEY -e ANTHROPIC_AUTH_TOKEN -e BRAVE_API_KEY -e TAVILY_API_KEY \
    -v "$out_abs:/reports" \
    --entrypoint node \
    "$image" apps/generic-corp/dist/evals-cli.js "${args[@]}" --out /reports
else
  if [ "$build" = true ]; then
    npm run build
  fi
  npm run evals -w @generic-ai/app-generic-corp -- "${args[@]}" --out "$(cd "$out" && pwd)"
fi
