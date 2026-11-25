#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  HOME=/home/node exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
