#!/usr/bin/env bash
# Build the Engine and CLI, then activate the release under a lock on the Host.
# Usage: pnpm deploy:host <ssh-target> (or set AMC_HOST)
set -euo pipefail
TARGET="${1:-${AMC_HOST:-}}"
VERSION="${AMC_RELEASE_VERSION:-}"
version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if [[ -n "$VERSION" && ! "$VERSION" =~ $version_pattern ]]; then
  echo "AMC_RELEASE_VERSION must be a stable numeric version." >&2
  exit 1
fi
if [[ -z "$TARGET" || "$TARGET" == -* ]]; then
  echo "Pass the SSH destination explicitly or set AMC_HOST." >&2
  exit 1
fi
cd "$(dirname "$0")/.."

if [[ -n "$VERSION" ]]; then
  SHA=$(git rev-parse HEAD)
else
  SHA=$(git rev-parse --short=12 HEAD)
fi
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ -n "$VERSION" || "${AMC_ALLOW_DIRTY:-}" != 1 ]]; then
    echo "Working tree is dirty; commit first." >&2
    exit 1
  fi
  SHA="$SHA-dirty-$(date +%s)-$$"
fi

echo "→ Checking and building $SHA"
pnpm -s check
pnpm -s build

stage=$(ssh "$TARGET" 'mktemp -d /tmp/amc-release.XXXXXXXX')
if [[ ! "$stage" =~ ^/tmp/amc-release\.[[:alnum:]]{8}$ ]]; then
  echo "Invalid Host staging path." >&2
  exit 1
fi
trap 'ssh "$TARGET" "rm -rf -- $stage" >/dev/null 2>&1 || true' EXIT
scp -q apps/engine/dist/amc-engine.mjs apps/engine/dist/amc-engine.mjs.map apps/cli/dist/amc.mjs \
  deploy/amc-backup.service deploy/amc-backup.timer "$TARGET:$stage/"

echo "→ Activating Engine release $SHA"
ssh "$TARGET" "sudo -n flock -n -E 75 /opt/amc/.deploy.lock bash -s -- $SHA $stage '$VERSION'" \
  < scripts/activate-host-release.sh

# Skills belong to the SSH user. Keep the healthy Engine active if refresh fails.
if ! ssh "$TARGET" /usr/local/bin/amc skills install; then
  echo "Engine is active. Retry '/usr/local/bin/amc skills install' as the SSH login." >&2
  if [[ -n "$VERSION" ]]; then exit 76; fi
fi
