#!/bin/sh
# Runs an Engine admin command (pair, migrate, …) as the amc user. Usage: sudo amc-engine pair
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo "amc-engine needs root to act as the amc user. Run: sudo amc-engine $*" >&2
  exit 1
fi
exec runuser -u amc -- env AMC_CONFIG=/etc/amc/config.json \
  /opt/amc/node/bin/node --disable-warning=ExperimentalWarning /opt/amc/current/amc-engine.mjs "$@"
