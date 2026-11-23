#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
build=apps/desktop/build
assets=docs/brand/assets
scratch=$(mktemp -d "${TMPDIR:-/tmp}/amc-icon.XXXXXX")
trap 'find "$scratch" -depth -delete' EXIT
iconset="$scratch/amc.iconset"
mkdir "$iconset"

# Remove the near-white backdrop and keep the edges and proportions of the approved image.
mask="$scratch/mark.png"
magick "$assets/coarse-stencil.png" -colorspace gray -negate -level 5%,95% \
  -trim +repage -strip "$mask"

color_mask() {
  magick "$1" \( +clone -fill "$2" -colorize 100 \) +swap \
    -compose CopyOpacity -composite -strip "PNG32:$3"
}

color_mask "$mask" '#000000' "$assets/mark.png"
color_mask "$mask" '#F8F8F8' "$assets/mark-paper.png"
magick -background none -density 768 "$assets/wordmark.svg" -trim +repage "$scratch/wordmark.png"

make_lockup() {
  magick -size 840x240 xc:none \
    \( "$1" -resize x192 \) -geometry +12+24 -composite \
    \( "$scratch/wordmark.png" -channel RGB -fill "$2" -colorize 100 +channel -resize x158 \) \
    -geometry +332+41 -composite -strip "PNG32:$3"
}

make_lockup "$assets/mark.png" '#000000' "$assets/lockup-ink.png"
make_lockup "$assets/mark-paper.png" '#F8F8F8' "$assets/lockup-paper.png"

magick -size 1024x1024 xc:none -fill '#FFFFFF' \
  -draw 'roundrectangle 80,80 943,943 194,194' \
  \( "$assets/mark.png" -resize 560x560 \) -gravity center -composite -strip "PNG32:$build/icon.png"

for size in 16 32 128 256 512; do
  for scale in 1 2; do
    suffix=
    [ "$scale" = 1 ] || suffix=@2x
    px=$((size * scale))
    magick "$build/icon.png" -resize "${px}x${px}" -strip \
      "PNG32:$iconset/icon_${size}x${size}$suffix.png"
  done
done
iconutil --convert icns --output "$build/icon.icns" "$iconset"

magick "$assets/mark.png" -resize 15x15 -background none -gravity center -extent 18x18 \
  -strip "PNG32:$build/trayTemplate.png"
magick "$assets/mark.png" -resize 30x30 -background none -gravity center -extent 36x36 \
  -strip "PNG32:$build/trayTemplate@2x.png"
magick "$assets/mark.png" -resize 108x108 -background none -gravity center -extent 128x128 \
  -strip PNG32:apps/desktop/src/renderer/src/assets/amc-mark.png
