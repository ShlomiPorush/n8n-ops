#!/bin/sh
# Runs a command as the node user: drops from root when started as root, runs it as is otherwise.
# Used by the server image's entrypoint and health check.
set -eu
if [ "$(id -u)" = 0 ]; then
  HOME=/home/node exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
