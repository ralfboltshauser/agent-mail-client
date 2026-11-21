#!/usr/bin/env bash
set -euo pipefail

bin_dir="$HOME/.local/bin"
data_dir="$HOME/.local/share/amc"
mkdir -p "$bin_dir" "$data_dir"
bundle=$(mktemp "$data_dir/.amc.XXXXXX")
launcher=$(mktemp "$bin_dir/.amc.XXXXXX")
trap 'rm -f "$bundle" "$launcher"' EXIT

install -m 644 apps/cli/dist/amc.mjs "$bundle"
cat > "$launcher" <<'LAUNCHER'
#!/bin/sh
set -eu

if [ -x /opt/homebrew/bin/node ]; then
  node=/opt/homebrew/bin/node
elif ! node=$(command -v node); then
  printf '%s\n' 'AMC requires Node 22.13 or later.' >&2
  exit 1
fi

exec "$node" "$HOME/.local/share/amc/amc.mjs" "$@"
LAUNCHER
chmod 755 "$launcher"
mv -f "$bundle" "$data_dir/amc.mjs"
mv -f "$launcher" "$bin_dir/amc"
printf 'Installed %s\n' "$bin_dir/amc"
