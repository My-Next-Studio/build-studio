#!/usr/bin/env bash
# Build the app icon from the SVG sources in icon/: icon.icns (what the .app
# uses, via package.json build.mac.icon) and a 1024 px icon.png.
#
# The sources are the crane from the studio-apps icon family (Claude Design,
# 2026-10). The small slots use their hand-tuned drawings, not a scaled-down
# master: 16 and 32 px are redrawn on whole pixels, 64 px has a thicker stroke.
#
# Needs rsvg-convert (brew install librsvg) and iconutil (macOS). Re-run after
# changing an SVG, and commit the regenerated icon.icns and icon.png.
set -euo pipefail

cd "$(dirname "$0")"
src=icon
set_dir="$(mktemp -d)/icon.iconset"
mkdir -p "$set_dir"

render() { rsvg-convert -w "$2" -h "$2" "$src/build-studio-$1.svg" -o "$set_dir/$3"; }

render 16   16   icon_16x16.png
render 32   32   icon_16x16@2x.png
render 32   32   icon_32x32.png
render 64   64   icon_32x32@2x.png
render 1024 128  icon_128x128.png
render 1024 256  icon_128x128@2x.png
render 1024 256  icon_256x256.png
render 1024 512  icon_256x256@2x.png
render 1024 512  icon_512x512.png
render 1024 1024 icon_512x512@2x.png

iconutil -c icns "$set_dir" -o icon.icns
rsvg-convert -w 1024 -h 1024 "$src/build-studio-1024.svg" -o icon.png
rm -rf "$(dirname "$set_dir")"
echo "wrote icon.icns and icon.png"
