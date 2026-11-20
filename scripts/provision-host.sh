#!/usr/bin/env bash
# Prepares the Host for the AMC Engine. Idempotent: safe to run again.
# Usage (from the repo on the Mac): scripts/provision-host.sh [ssh-target]   (default: ralf@ralfs-ubuntu)
set -euo pipefail
TARGET="${1:-${AMC_HOST:-ralf@ralfs-ubuntu}}"
NODE_MAJOR=26
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Copying deploy files to $TARGET"
ssh "$TARGET" 'rm -rf /tmp/amc-provision && mkdir -p /tmp/amc-provision'
scp -q "$HERE"/deploy/* "$TARGET":/tmp/amc-provision/

echo "→ Provisioning (sudo)"
ssh "$TARGET" "NODE_MAJOR=$NODE_MAJOR OWNER=\$(id -un) bash -s" <<'REMOTE'
set -euo pipefail
S=/tmp/amc-provision

# 1. The amc system user (ADR 0003).
if ! id amc >/dev/null 2>&1; then
  sudo useradd --system --home-dir /var/lib/amc --create-home --shell /usr/sbin/nologin amc
  echo "  created user amc"
fi

# 2. Directories: data and secrets readable by amc only.
sudo install -d -o amc -g amc -m 700 /srv/amc /srv/amc/db /srv/amc/blobs /srv/amc/backups /etc/amc /var/lib/amc
sudo install -d -o root -g root -m 755 /opt/amc /opt/amc/releases

# 3. A pinned Node runtime for the Engine, verified against nodejs.org's checksums.
ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=x64;; aarch64) ARCH=arm64;; esac
VERSION=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "import json,sys,os; m=os.environ['NODE_MAJOR']; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v'+m+'.')))")
if [ ! -x "/opt/amc/node-$VERSION/bin/node" ]; then
  TMP=$(mktemp -d)
  FILE="node-$VERSION-linux-$ARCH.tar.xz"
  curl -fsSL -o "$TMP/$FILE" "https://nodejs.org/dist/$VERSION/$FILE"
  curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/$VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  sudo mkdir -p "/opt/amc/node-$VERSION"
  sudo tar -xJf "$TMP/$FILE" -C "/opt/amc/node-$VERSION" --strip-components=1
  rm -rf "$TMP"
  echo "  installed Node $VERSION"
fi
sudo ln -sfn "/opt/amc/node-$VERSION" /opt/amc/node

# 4. Move the Google OAuth client out of the owner's home (ADR 0003).
OLD="/home/$OWNER/.config/amc/google-oauth-client.json"
if [ -f "$OLD" ]; then
  sudo install -o amc -g amc -m 600 "$OLD" /etc/amc/google-oauth-client.json
  rm -f "$OLD"; rmdir "/home/$OWNER/.config/amc" 2>/dev/null || true
  echo "  moved the Google OAuth client to /etc/amc"
fi

# 4b. The key that seals provider credentials at rest (never leaves the Host).
if ! sudo test -f /etc/amc/key; then
  sudo sh -c 'head -c 32 /dev/urandom > /etc/amc/key'
  sudo chown amc:amc /etc/amc/key && sudo chmod 600 /etc/amc/key
  echo "  created the credential encryption key"
fi

# 5. Engine config (written once; edit /etc/amc/config.json by hand afterwards).
if ! sudo test -f /etc/amc/config.json; then
  LOGIN=$(tailscale status --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['User'][str(d['Self']['UserID'])]['LoginName'])")
  sudo tee /etc/amc/config.json >/dev/null <<JSON
{
  "listen": { "host": "127.0.0.1", "port": 4410 },
  "dataDir": "/srv/amc/db",
  "blobDir": "/srv/amc/blobs",
  "secretsDir": "/etc/amc",
  "backupDir": "/srv/amc/backups",
  "allowedTailscaleLogins": ["$LOGIN"],
  "logLevel": "info"
}
JSON
  sudo chown amc:amc /etc/amc/config.json && sudo chmod 600 /etc/amc/config.json
  echo "  wrote /etc/amc/config.json"
fi

# 6. Service and admin commands.
sudo install -m 644 "$S/amc-engine.service" /etc/systemd/system/amc-engine.service
sudo install -m 755 "$S/amc-engine-wrapper.sh" /usr/local/bin/amc-engine
sudo install -m 755 "$S/amc-cli-wrapper.sh" /usr/local/bin/amc
sudo systemctl daemon-reload
sudo systemctl enable amc-engine.service >/dev/null 2>&1

# 7. Tailnet-only HTTPS on :4443 → the Engine (never Funnel).
sudo tailscale serve --bg --https=4443 http://127.0.0.1:4410 >/dev/null
rm -rf "$S"
echo "  done"
REMOTE
echo "✓ Host provisioned. Next: pnpm deploy:host"
