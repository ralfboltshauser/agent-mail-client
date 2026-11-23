#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
build=apps/desktop/build
mark=docs/brand/assets/mark.svg
iconset_root=$(mktemp -d "${TMPDIR:-/tmp}/amc-icon.XXXXXX")
trap 'find "$iconset_root" -depth -delete' EXIT
iconset="$iconset_root/amc.iconset"
mkdir "$iconset"

{
  printf '%s\n' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
  printf '%s\n' '  <rect x="80" y="80" width="864" height="864" rx="194" fill="#151515"/>'
  printf '%s\n' '  <g transform="translate(248 292) scale(22)">'
  sed -n 's/^  <path fill="#151515"/    <path fill="#F8F7F3"/p' "$mark"
  printf '%s\n' '  </g>' '</svg>'
} > "$build/icon.svg"

for size in 16 32 128 256 512; do
  for scale in 1 2; do
    suffix=
    [ "$scale" = 1 ] || suffix=@2x
    px=$((size * scale))
    magick -background none -density 384 "$build/icon.svg" -resize "${px}x${px}" -strip \
      "PNG32:$iconset/icon_${size}x${size}$suffix.png"
  done
done
iconutil --convert icns --output "$build/icon.icns" "$iconset"

{
  printf '%s\n' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">'
  printf '%s\n' '  <g transform="translate(1.5 2.75) scale(.625)">'
  sed -n 's/^  <path fill="#151515"/    <path fill="#000000"/p' "$mark"
  printf '%s\n' '  </g>' '</svg>'
} > "$build/trayTemplate.svg"

magick -background none -density 384 "$build/trayTemplate.svg" -resize 18x18 -strip "PNG32:$build/trayTemplate.png"
magick -background none -density 384 "$build/trayTemplate.svg" -resize 36x36 -strip "PNG32:$build/trayTemplate@2x.png"

magick -background none -density 768 "$mark" -resize 108x108 -gravity center -extent 128x128 \
  -strip PNG32:apps/desktop/src/renderer/src/assets/amc-mark.png
