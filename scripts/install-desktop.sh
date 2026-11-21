#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  printf '%s\n' 'AMC desktop installation requires an Apple silicon Mac.' >&2
  exit 1
fi

pnpm --filter @amc/desktop package:dir
destination="$HOME/Applications"
mkdir -p "$destination"
staging=$(mktemp -d "$destination/.amc-install.XXXXXX")
trap 'rm -rf "$staging"' EXIT

app="$destination/AMC.app"
ditto apps/desktop/dist/mac-arm64/AMC.app "$staging/AMC.app"
if [[ -e "$app" ]]; then
  mv "$app" "$staging/previous.app"
fi
if ! mv "$staging/AMC.app" "$app"; then
  if [[ -e "$staging/previous.app" ]]; then
    if ! mv "$staging/previous.app" "$app"; then
      trap - EXIT
      printf 'Previous app saved at %s\n' "$staging/previous.app" >&2
    fi
  fi
  exit 1
fi
printf 'Installed %s\n' "$app"
