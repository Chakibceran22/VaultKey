#!/bin/sh
# Renders the extension's icons from assets/icon.svg (48, 128 px) and
# assets/icon-small.svg (16, 32 px) into public/icon/<size>.png, where WXT finds them.
# Uses the Tauri CLI the desktop app already has (no other tool needed).
#
#   sh scripts/icons.sh      (from desktop/extension)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$here/.."
pnpm --silent tauri icon "$here/assets/icon.svg" -o "$work/big" -p 48,128 >/dev/null
pnpm --silent tauri icon "$here/assets/icon-small.svg" -o "$work/small" -p 16,32 >/dev/null
mkdir -p "$here/public/icon"
for size in 16 32; do cp "$work/small/${size}x${size}.png" "$here/public/icon/$size.png"; done
for size in 48 128; do cp "$work/big/${size}x${size}.png" "$here/public/icon/$size.png"; done
echo "icons written to public/icon/"
