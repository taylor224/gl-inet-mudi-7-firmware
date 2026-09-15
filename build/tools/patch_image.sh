#!/bin/sh
# Apply build/patch/ onto a raw ext4 image, inside a Linux container.
#
# macOS cannot mount ext4, and unpacking with 7-Zip loses symlinks, modes and
# ownership -- so the image is never unpacked. It is loop-mounted read-write in
# a throwaway container and the patch tree is copied straight in.
#
# usage: patch_image.sh <image> <patch-dir>

set -eu

IMAGE=$1
PATCH=$2
IMAGE_DIR=$(cd "$(dirname "$IMAGE")" && pwd)
IMAGE_NAME=$(basename "$IMAGE")
PATCH_DIR=$(cd "$PATCH" && pwd)

if ! docker info >/dev/null 2>&1; then
    echo "docker is not running -- start Docker Desktop and retry" >&2
    exit 1
fi

# Nothing to do if the patch tree holds only the placeholder README.
FILE_COUNT=$(find "$PATCH_DIR" -type f \
    ! -name 'README*' ! -name '.delete' ! -name '.DS_Store' | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ] && [ ! -s "$PATCH_DIR/.delete" ]; then
    echo "patch/ is empty -- image left unchanged"
    exit 0
fi

echo "applying patch tree to $IMAGE_NAME ..."

docker run --rm --privileged \
    -v "$IMAGE_DIR":/img \
    -v "$PATCH_DIR":/patch:ro \
    alpine:3.20 sh -eu -c '
    apk add --no-cache e2fsprogs rsync >/dev/null

    mkdir -p /mnt/root
    mount -o loop,rw /img/'"$IMAGE_NAME"' /mnt/root

    # Deletions first, so a path can be replaced by a different type.
    if [ -s /patch/.delete ]; then
        while IFS= read -r target; do
            case "$target" in ""|\#*) continue ;; esac
            echo "  delete $target"
            rm -rf "/mnt/root/${target#/}"
        done < /patch/.delete
    fi

    # Copy everything except the bookkeeping files, preserving links and modes.
    rsync -a --exclude=.delete --exclude="README*" --exclude=.DS_Store \
        /patch/ /mnt/root/ || { echo "copy failed" >&2; umount /mnt/root; exit 1; }

    chown -R 0:0 /mnt/root

    echo "  free space after patch:"
    df -h /mnt/root | tail -1

    sync
    umount /mnt/root
    e2fsck -fp /img/'"$IMAGE_NAME"' || [ $? -le 2 ]
'

echo "patch applied"
