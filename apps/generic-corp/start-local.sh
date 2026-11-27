#!/usr/bin/env bash
# Starts Generic Corp on this machine in Docker and tells you what to do next.
#
#   ./apps/generic-corp/start-local.sh          # build and start (or restart)
#   ./apps/generic-corp/start-local.sh logs     # follow the app's log
#   ./apps/generic-corp/start-local.sh stop     # stop; your company's data is kept
#   ./apps/generic-corp/start-local.sh backups  # list the nightly backups
#   ./apps/generic-corp/start-local.sh restore <backup id|latest>
#                                               # put a backup back, then start
#
# Needs Docker with Compose v2. Everything else runs in containers. See
# apps/generic-corp/RUN-LOCALLY.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose -f "$here/compose.yaml")
port="${GENERIC_CORP_PORT:-3000}"
url="http://localhost:${port}"

case "${1:-start}" in
  logs)
    exec "${compose[@]}" logs -f app
    ;;
  stop)
    exec "${compose[@]}" stop
    ;;
  backups)
    exec "${compose[@]}" run --rm app node apps/generic-corp/dist/restore.js
    ;;
  restore)
    if [[ $# -lt 2 ]]; then
      echo "Usage: $0 restore <backup id|latest>   (list them with: $0 backups)" >&2
      exit 2
    fi
    # The app must not be running while its database and files are replaced.
    "${compose[@]}" stop app
    "${compose[@]}" run --rm app node apps/generic-corp/dist/restore.js "$2" --yes
    exec "$0" start
    ;;
  start) ;;
  *)
    echo "Usage: $0 [start|logs|stop|backups|restore <backup>]" >&2
    exit 2
    ;;
esac

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker with Compose v2 is needed: https://docs.docker.com/get-docker/" >&2
  exit 1
fi

echo "Building and starting Generic Corp (the first build takes a few minutes)..."
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"${compose[@]}" up --build --detach

printf "Waiting for it to be ready"
for _ in $(seq 1 90); do
  container="$("${compose[@]}" ps -q app 2>/dev/null || true)"
  health="$( [[ -n "$container" ]] && docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo starting)"
  if [[ "$health" == "healthy" ]]; then
    break
  fi
  printf "."
  sleep 2
done
echo
if [[ "${health:-}" != "healthy" ]]; then
  echo "Generic Corp did not become ready. Its log:" >&2
  "${compose[@]}" logs --tail 50 app >&2
  exit 1
fi

echo
echo "Generic Corp is running at ${url}"
token="$("${compose[@]}" logs --no-log-prefix --since "$since" app 2>/dev/null | grep -A1 "one-time setup token" | tail -n1 | tr -d '[:space:]' || true)"
if [[ -n "$token" ]]; then
  echo
  echo "1. Open ${url}/auth/login and create your passkey with this setup token:"
  echo "     ${token}"
else
  echo
  echo "1. Open ${url}/auth/login and sign in with your passkey."
fi
echo "2. Open More, then Claude sign-in, and sign in with your Claude account."
echo "3. On the Goals screen, type your first goal under \"Set a goal\" and press Set goal."
echo
echo "Follow the log with: $0 logs"
echo "Stop with:           $0 stop   (your company's data is kept)"
