#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 || ( $# -eq 1 && $1 != --from-package ) ]]; then
  printf '%s\n' 'Usage: scripts/install-desktop.sh [--from-package]' >&2
  exit 1
fi

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  printf '%s\n' 'AMC desktop installation requires an Apple silicon Mac.' >&2
  exit 1
fi

destination="$HOME/Applications"
app="$destination/AMC.app"
bundle_id=$(node -p 'require("./apps/desktop/electron-builder.json").appId')

check_destination() {
  if [[ ! -e "$app" && ! -L "$app" ]]; then return; fi
  if [[ ! -d "$app" || -L "$app" || ! -f "$app/Contents/Info.plist" ||
    $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null) != "$bundle_id" ]]; then
    printf 'Refusing to replace %s because its bundle ID is not %s.\n' "$app" "$bundle_id" >&2
    exit 1
  fi
}

check_destination
if [[ $# -eq 0 ]]; then
  pnpm --filter @amc/desktop package:dir
fi
mkdir -p "$destination"
staging=$(mktemp -d "$destination/.amc-install.XXXXXX")
previous="$staging/previous.app"
installed=false

cleanup() {
  if [[ -e "$previous" ]]; then
    if ! "$installed" && [[ ! -e "$app" && ! -L "$app" ]]; then
      mv "$previous" "$app" || true
    fi
    if [[ -e "$previous" ]]; then
      printf 'Previous AMC app saved at %s\n' "$previous" >&2
    fi
  fi
  rm -rf "$staging/AMC.app"
  rmdir "$staging" 2>/dev/null || true
}
trap cleanup EXIT

ditto "apps/desktop/dist/mac-arm64/AMC.app" "$staging/AMC.app"
/usr/bin/codesign --verify --deep --strict "$staging/AMC.app"
[[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$staging/AMC.app/Contents/Info.plist") == "$bundle_id" ]]
check_destination
if [[ -e "$app" ]]; then
  # Reserve a unique Trash location before moving the installed app.
  mkdir -p "$HOME/.Trash"
  trash=$(mktemp -d "$HOME/.Trash/AMC.XXXXXX")
  mv "$app" "$previous"
fi
# Rename to the exact destination. An intervening install must never receive
# this bundle as a nested directory.
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staging/AMC.app" "$app"
installed=true
if [[ -e "$previous" ]]; then
  mv "$previous" "$trash/AMC.app"
fi
printf 'Installed %s\n' "$app"
