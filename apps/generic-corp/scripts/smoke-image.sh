#!/usr/bin/env bash
# Smoke test for the Generic Corp production image, run in CI and locally.
#
#   apps/generic-corp/scripts/smoke-image.sh <image> [--browser]
#
# Starts Postgres, runs the pre-deploy migration, starts the server the way
# Railway does (RAILWAY_PUBLIC_DOMAIN set, PORT chosen by the platform), and
# checks health, readiness, auth, the setup token in the log, the non-root
# user, the agent tool binaries, recovery from a database restart and a clean
# shutdown. With --browser it also launches headless Chrome through the
# pinned Playwright MCP package, as the browser connector does.
set -euo pipefail

image="${1:?usage: smoke-image.sh <image> [--browser]}"
check_browser="${2:-}"
postgres_image="${POSTGRES_IMAGE:-postgres:17-alpine}"
playwright_mcp="$(sed -n 's/^ARG PLAYWRIGHT_MCP_PACKAGE=//p' "$(dirname "$0")/../Dockerfile")"

net="gc-smoke-$$"
pg="$net-pg"
app="$net-app"
url="postgres://postgres:smoke@$pg:5432/postgres"

cleanup() {
  docker rm -f "$app" "$pg" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs "$app" 2>&1 | tail -40 >&2 || true
  exit 1
}

step() { echo "== $*"; }

wait_for() {
  local what="$1" cmd="$2" tries="${3:-60}"
  for _ in $(seq "$tries"); do
    if eval "$cmd" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}

status_of() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$1"; }

step "Postgres"
docker network create "$net" >/dev/null
docker run -d --name "$pg" --network "$net" -e POSTGRES_PASSWORD=smoke "$postgres_image" >/dev/null
wait_for "Postgres" "docker exec $pg pg_isready -U postgres -h 127.0.0.1"

step "Pre-deploy migration"
docker run --rm --network "$net" -e DATABASE_URL="$url" "$image" node apps/generic-corp/dist/migrate.js
docker run --rm --network "$net" -e DATABASE_URL="$url" "$image" node apps/generic-corp/dist/migrate.js \
  | grep -q "up to date" || fail "second migration run was not a no-op"

# Stand-in secrets: the probe below checks none of them reach agent commands.
api_key="sk-ant-smoke-$$-provider-key"
secrets_key="smoke-$$-secrets-master-key-0123456789"

step "Server, configured like Railway"
docker run -d --name "$app" --network "$net" \
  -e DATABASE_URL="$url" \
  -e ANTHROPIC_API_KEY="$api_key" \
  -e GENERIC_AI_SECRETS_KEY="$secrets_key" \
  -e RAILWAY_PUBLIC_DOMAIN=smoke.example.com \
  -e PORT=8080 \
  -p 127.0.0.1::8080 \
  "$image" >/dev/null
port="$(docker port "$app" 8080/tcp | head -n1 | sed 's/.*://')"
wait_for "/ready" "[ \"\$(status_of /ready)\" = 200 ]"

[ "$(status_of /health)" = 200 ] || fail "/health is not 200"
[ "$(status_of /api/agents)" = 401 ] || fail "/api/agents answered without auth"
docker logs "$app" 2>&1 | grep -q "https://smoke.example.com/auth/login and use this one-time setup token" \
  || fail "setup token line missing from the log"
# The one-time setup token lives only in the server's memory and log.
setup_token="$(docker logs "$app" 2>&1 | grep -A1 "one-time setup token" | tail -n1 | tr -d ' ')"
[ "${#setup_token}" -ge 16 ] || fail "could not read the setup token from the log"

step "Runs as the node user, with the agent tools on PATH"
docker exec "$app" sh -c '
  for p in /proc/[0-9]*; do
    if tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "^node apps/generic-corp/dist/run.js"; then
      awk "/^Uid:/ { print \$2 }" "$p/status"
    fi
  done' | grep -qx 1000 || fail "server is not running as uid 1000"
docker exec -u node "$app" sh -c 'command -v bash && command -v git && command -v rg && command -v fd' >/dev/null \
  || fail "bash, git, rg or fd missing"
docker exec -u node "$app" sh -c 'touch /data/.write-test && rm /data/.write-test' \
  || fail "/data is not writable by node"
if docker exec -u node "$app" sh -c 'touch /app/apps/generic-corp/dist/run.js' 2>/dev/null; then
  fail "the server code is writable by node, so an agent could change it"
fi

step "Agent commands cannot see the server's secrets (environment or /proc)"
# The probe holds the same secret variables as the server and is started the
# same way (as root through the entrypoint, which drops to node), so this
# checks both routes: inherited environment and /proc/<pid>/environ of the
# server and of the probe itself.
docker exec \
  -e DATABASE_URL="$url" \
  -e ANTHROPIC_API_KEY="$api_key" \
  -e GENERIC_AI_SECRETS_KEY="$secrets_key" \
  "$app" generic-corp-entrypoint node apps/generic-corp/scripts/agent-env-probe.mjs \
  "$api_key" "$url" "smoke@$pg" "$secrets_key" "$setup_token" \
  || fail "a secret reached an agent command"

step "Recovers from a database restart"
docker restart "$pg" >/dev/null
wait_for "Postgres after restart" "docker exec $pg pg_isready -U postgres -h 127.0.0.1"
wait_for "/ready after restart" "[ \"\$(status_of /ready)\" = 200 ]"
[ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$app")" = "true 0" ] \
  || fail "server crashed when Postgres restarted"

if [ "$check_browser" = "--browser" ]; then
  step "Headless Chrome through $playwright_mcp"
  docker exec -u node -w /tmp "$app" \
    npx -y -p "$playwright_mcp" playwright screenshot --channel chrome about:blank /tmp/blank.png \
    || fail "Chrome did not launch"
fi

step "Clean shutdown"
docker stop -t 20 "$app" >/dev/null
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$app")"
[ "$exit_code" = 0 ] || fail "server exited with $exit_code on SIGTERM"

echo "OK: $image passed the smoke test"
