#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' "Run pnpm verify on macOS to exercise both native scrollbar modes." >&2
  exit 1
fi

pnpm install --frozen-lockfile
bash test/release/activate-host.sh
pnpm check
pnpm build
pnpm test:html-reader -AppleShowScrollBars Always
pnpm test:html-reader -AppleShowScrollBars WhenScrolling
