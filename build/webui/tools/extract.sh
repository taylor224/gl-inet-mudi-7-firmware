#!/bin/sh
# Pull the view bundles we intend to edit out of the stock rootfs into orig/.
#
# usage: extract.sh <sysroot> [view ...]
set -eu
SYSROOT=$1
shift
HERE=$(cd "$(dirname "$0")/.." && pwd)
VIEWS=${*:-"internet login wireless cellular-detail"}

mkdir -p "$HERE/orig"
for v in $VIEWS; do
    src="$SYSROOT/www/views/gl-sdk4-ui-$v.common.js.gz"
    [ -f "$src" ] || { echo "missing: $src" >&2; exit 1; }
    gunzip -c "$src" > "$HERE/orig/$v.js"
    printf '%-18s %8d bytes\n' "$v" "$(wc -c < "$HERE/orig/$v.js")"
done
