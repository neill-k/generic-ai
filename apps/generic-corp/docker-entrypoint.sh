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

# Files the server and agents create are not readable by other users. The
# company folder (the shared drive and every agent home) is shared with the
# `agent` group, so the server and agent commands can both work in it.
umask 0007

if [ "$(id -u)" = "0" ]; then
  company_dir="$data_dir/company"
  mkdir -p "$company_dir"
  # Only touch files that need it, so restarts stay fast.
  #
  # Server data (database, artifacts, anything outside the company) belongs to
  # node and is closed to everyone else. Agent commands run as `agent`, which
  # may pass through /data but not list or read it.
  find "$data_dir" -path "$company_dir" -prune -o ! -user node -exec chown node:node {} +
  find "$data_dir" -path "$company_dir" -prune -o -perm /o=rwx -exec chmod o-rwx {} +
  chmod 0711 "$data_dir"
  # The company: owned by node (which creates it), group `agent`, readable
  # and writable by the group, and setgid so new files join the group.
  # Files an agent command created stay owned by `agent`.
  find "$company_dir" ! -user node ! -user agent -exec chown node {} +
  find "$company_dir" ! -group agent -exec chgrp agent {} +
  find "$company_dir" -type d ! -perm -2770 -exec chmod g+rwxs {} +
  find "$company_dir" ! -type d ! -type l ! -perm -0060 -exec chmod g+rw {} +
  find "$company_dir" ! -type l -perm /o=rwx -exec chmod o-rwx {} +
  exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node USER=node "$@"
fi

exec "$@"
