#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  [ "$(stat -c %U /data)" = node ] || chown -R node:node /data
  if awk '$5 == "/backups" { found = 1 } END { exit !found }' /proc/self/mountinfo; then
    # -R would change the owner of every archive already in the mapped host folder.
    chown node:node /backups
  fi
fi
exec as-node docker-entrypoint.sh "$@"
