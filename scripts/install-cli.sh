#!/usr/bin/env bash
set -euo pipefail

force=false
if [[ ${1:-} == --force ]]; then
  force=true
  shift
fi
if [[ $# -ne 0 ]]; then
  printf '%s\n' 'Usage: pnpm cli:install [--force]' >&2
  exit 1
fi

bin_dir="$HOME/.local/bin"
data_dir="$HOME/.local/share/amc"
target="$bin_dir/amc"
payload="$data_dir/amc.mjs"
launcher_marker='# Managed by the AMC CLI installer'
payload_marker='// Managed by the AMC CLI installer'

if [[ -e "$target" || -L "$target" ]]; then
  if [[ -d "$target" && ! -L "$target" ]]; then
    printf 'Refusing to replace directory %s.\n' "$target" >&2
    exit 1
  fi
  if ! "$force" && ! {
    [[ -f "$target" && ! -L "$target" ]] && grep -Fxq "$launcher_marker" "$target"
  }; then
    printf 'Refusing to replace %s because it is not a marked AMC launcher. Use pnpm cli:install --force to replace it.\n' "$target" >&2
    exit 1
  fi
fi

if [[ -e "$payload" || -L "$payload" ]]; then
  if ! { [[ -f "$payload" && ! -L "$payload" ]] && {
    [[ $(tail -n 1 "$payload") == "$payload_marker" ]] ||
      cmp -s "$payload" apps/cli/dist/amc.mjs
  }; }; then
    printf 'Refusing to replace %s because it is not an AMC-managed payload. Move it aside and retry.\n' "$payload" >&2
    exit 1
  fi
fi

mkdir -p "$bin_dir" "$data_dir"
bundle=$(mktemp "$data_dir/.amc.XXXXXX")
launcher=
trap 'rm -f "$bundle" "$launcher"' EXIT
launcher=$(mktemp "$bin_dir/.amc.XXXXXX")

install -m 644 apps/cli/dist/amc.mjs "$bundle"
printf '\n%s\n' "$payload_marker" >> "$bundle"
cat > "$launcher" <<'LAUNCHER'
#!/bin/sh
# Managed by the AMC CLI installer
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
# Rename to the exact path, including when --force replaces a symlink to a directory.
node --input-type=module -e '
  import { renameSync } from "node:fs"
  const [bundle, payload, launcher, target] = process.argv.slice(1)
  renameSync(bundle, payload)
  renameSync(launcher, target)
' "$bundle" "$payload" "$launcher" "$target"
printf 'Installed %s\n' "$target"
