#!/bin/bash
# Build a system-only A/B OTA package for the GL.iNet e5800.
#
#   ./build.sh                 full mode (default), verified after write
#   ./build.sh --mode sparse   skip all-zero blocks, smaller .dat
#   ./build.sh --reunpack      rebuild the pristine image from the stock package
#
# Drop the files you want changed into build/patch/, mirroring the rootfs:
#   build/patch/www/views/gl-sdk4-ui-home.common.js.gz
#   build/patch/etc/gl_screen/config/product/ndpr/layout
# List paths to remove, one per line, in build/patch/.delete

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
WORK="$HERE/work"
OUT="$HERE/out"
PATCHDIR="$HERE/patch"
STAGING="$WORK/staging"
PRISTINE="$WORK/system.pristine.img"
IMAGE="$WORK/system.img"

MODE=full
REUNPACK=0
ZIP_LEVEL=${ZIP_LEVEL:-1}

while [ $# -gt 0 ]; do
    case "$1" in
        --mode) MODE=$2; shift 2 ;;
        --reunpack) REUNPACK=1; shift ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

STOCK=$(find "$ROOT" -maxdepth 1 -type d -name 'e5800-*' | head -1)
[ -n "$STOCK" ] || { echo "stock package directory e5800-* not found under $ROOT" >&2; exit 1; }

mkdir -p "$WORK" "$OUT" "$PATCHDIR"

echo "stock package : $(basename "$STOCK")"
echo "mode          : $MODE"
echo

# --- 1. pristine image -------------------------------------------------------
if [ "$REUNPACK" = 1 ] || [ ! -f "$PRISTINE" ]; then
    echo "[1/4] unpacking stock system image"
    python3 "$HERE/tools/sdat2img.py" \
        "$STOCK/system.transfer.list" "$STOCK/system.new.dat" "$PRISTINE"
else
    echo "[1/4] reusing $PRISTINE ($(( $(wc -c < "$PRISTINE") / 1048576 )) MB)"
fi

# --- 2. fresh working copy ---------------------------------------------------
echo "[2/4] making a working copy"
rm -f "$IMAGE"
cp -c "$PRISTINE" "$IMAGE" 2>/dev/null || cp "$PRISTINE" "$IMAGE"

# --- 3. apply the patch tree -------------------------------------------------
echo "[3/4] applying patch tree"
"$HERE/tools/patch_image.sh" "$IMAGE" "$PATCHDIR"

# --- 4. build the package ----------------------------------------------------
echo "[4/4] building package"
python3 "$HERE/tools/mkpackage.py" "$IMAGE" "$STAGING" --stock "$STOCK" --mode "$MODE"

STAMP=$(date +%Y%m%d-%H%M%S)
ZIP="$OUT/e5800-slim-$MODE-$STAMP.zip"
rm -f "$ZIP"
( cd "$STAGING" && find . -name .DS_Store -delete && zip -X -r -"$ZIP_LEVEL" -q "$ZIP" . )

unzip -tq "$ZIP" >/dev/null || { echo "zip failed its own integrity check" >&2; exit 1; }

echo
echo "package : $ZIP"
echo "size    : $(( $(wc -c < "$ZIP") / 1048576 )) MB"
echo "sha256  : $(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
echo
echo "contents:"
unzip -l "$ZIP" | sed -n '3,16p'
echo
echo "next: ./flash.sh \"$ZIP\"   (add --yes to actually write to the device)"
