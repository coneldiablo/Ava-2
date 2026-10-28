#!/bin/sh
set -eu

chown psiphon:psiphon /data
exec runuser -u psiphon -- "$@"
