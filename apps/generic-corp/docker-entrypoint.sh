#!/bin/sh
# Entrypoint for the Generic Corp image.
#
# Railway (and some Docker setups) mount volumes owned by root. When the
# container starts as root, give the data directory to the `node` user and
# then run the command as `node`, so neither the server nor the agents' shell
# commands run as root. When it already starts as another user, run the
# command unchanged.
set -eu

data_dir="${GENERIC_CORP_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data_dir"
  # Only touch files that are not already owned by node, so restarts stay fast.
  find "$data_dir" ! -user node -exec chown node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node USER=node "$@"
fi

exec "$@"
