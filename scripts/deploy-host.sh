#!/usr/bin/env bash
# Builds the Engine and CLI, ships them to the Host as a new release, migrates, restarts,
# and rolls back automatically if the Engine does not come up healthy.
# Usage: pnpm deploy:host [ssh-target]   (default: ralf@ralfs-ubuntu)
set -euo pipefail
TARGET="${1:-${AMC_HOST:-ralf@ralfs-ubuntu}}"
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ] && [ "${AMC_ALLOW_DIRTY:-}" != "1" ]; then
  echo "Working tree is dirty; commit first (or AMC_ALLOW_DIRTY=1)." >&2
  exit 1
fi
SHA=$(git rev-parse --short=12 HEAD)
[ -n "$(git status --porcelain)" ] && SHA="$SHA-dirty"

echo "→ Checking and building $SHA"
pnpm -s check
pnpm -s build

echo "→ Shipping release $SHA to $TARGET"
ssh "$TARGET" "rm -rf /tmp/amc-release && mkdir -p /tmp/amc-release"
scp -q apps/engine/dist/amc-engine.mjs apps/engine/dist/amc-engine.mjs.map apps/cli/dist/amc.mjs \
  deploy/amc-backup.service deploy/amc-backup.timer "$TARGET":/tmp/amc-release/

ssh "$TARGET" "SHA=$SHA bash -s" <<'REMOTE'
set -euo pipefail
REL=/opt/amc/releases/$SHA
PREV=$(readlink -f /opt/amc/current 2>/dev/null || true)
sudo rm -rf "$REL" && sudo mkdir -p "$REL"
trap 'rm -rf /tmp/amc-release' EXIT
sudo install -m 644 /tmp/amc-release/*.mjs /tmp/amc-release/*.mjs.map "$REL"/
echo "$SHA" | sudo tee "$REL/RELEASE" >/dev/null

sudo ln -sfn "$REL" /opt/amc/current
if ! sudo systemd-cat --identifier=amc-migration /usr/local/bin/amc-engine migrate --journal; then
  echo "✗ migration failed; rolling back (see local journal tag amc-migration)" >&2
  [ -n "$PREV" ] && sudo ln -sfn "$PREV" /opt/amc/current
  exit 1
fi
sudo systemctl restart amc-engine.service

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4410/health >/dev/null 2>&1; then
    echo "✓ Engine healthy: $(curl -fsS http://127.0.0.1:4410/health)"
    sudo install -m 644 /tmp/amc-release/amc-backup.service /tmp/amc-release/amc-backup.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable amc-backup.timer
    sudo systemctl restart amc-backup.timer
    # Keep the five newest releases.
    ls -1dt /opt/amc/releases/* | tail -n +6 | xargs -r sudo rm -rf
    exit 0
  fi
  sleep 0.5
done

echo "✗ Engine did not become healthy; rolling back" >&2
sudo journalctl -u amc-engine.service -n 30 --no-pager >&2 || true
if [ -n "$PREV" ]; then
  sudo ln -sfn "$PREV" /opt/amc/current
  sudo systemctl restart amc-engine.service
fi
exit 1
REMOTE
