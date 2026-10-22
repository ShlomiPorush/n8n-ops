#!/bin/sh
# The server image starts as root only to hand /data to node: a host directory that Docker creates
# for the bind mount belongs to root, and the server must write its app key there. Then it runs the
# server as node through the base image's entrypoint. Started as node already, it skips the chown.
#
# /backups, the folder for local backup destinations, gets the same for its top folder only, and only
# when a host folder is mapped there: archives written before keep their owner, and an unmapped
# /backups stays as the image made it (the server then refuses to write archives into it).
set -eu
if [ "$(id -u)" = 0 ]; then
  chown -R node:node /data
  if awk '$5 == "/backups" { found = 1 } END { exit !found }' /proc/self/mountinfo; then
    chown node:node /backups
  fi
fi
exec as-node docker-entrypoint.sh "$@"
