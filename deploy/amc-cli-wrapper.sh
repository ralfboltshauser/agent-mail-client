#!/bin/sh
# The amc CLI on the Host, using AMC's pinned Node.
exec /opt/amc/node/bin/node /opt/amc/current/amc.mjs "$@"
