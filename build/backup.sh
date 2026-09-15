#!/bin/bash
# Snapshot everything on the device that a rollback might need, before writing
# a package to it.
#
# The stock system partition is not pulled: build/work/system.pristine.img is
# already a byte-exact copy of it, unpacked from the vendor package the device
# is running. What is NOT reproducible from that package is everything the
# overlay holds -- every setting, key and change made since the device left the
# factory -- so that is what this collects.
#
#   ./backup.sh --port <ssh port> [--host 192.168.8.1]
#
# Each unit gets its own SSH port; read it from the admin panel under
# System > Advanced, or with `ubus call local-access status`.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
HOST=${HOST:-192.168.8.1}
PORT=${SSH_PORT:-}
SSH_USER=${SSH_USER:-root}
SSH_KEY=${SSH_KEY:-}

while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST=$2; shift 2 ;;
        --port) PORT=$2; shift 2 ;;
        --key)  SSH_KEY=$2; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

[ -n "$PORT" ] || { echo "ssh port required -- pass --port or set SSH_PORT (see the header)" >&2; exit 2; }
[ -n "$SSH_KEY" ] || { echo "ssh key required -- pass --key or set SSH_KEY" >&2; exit 2; }

SSH="ssh -p $PORT -i $SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new $SSH_USER@$HOST"
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$HERE/backup/$STAMP"
mkdir -p "$DEST/files"

quiet() { grep -vE "post-quantum|store now|openssh.com/pq|may need to be upgraded" || true; }

echo "backing up $SSH_USER@$HOST:$PORT -> $DEST"

# --- 1. what the device is, right now -------------------------------------
echo "[1/5] device state"
$SSH '
    echo "=== identity ==="
    echo "model      : $(cat /proc/gl-hw-info/model 2>/dev/null)"
    echo "firmware   : $(cat /etc/glversion) build $(cat /etc/version.build) $(cat /etc/version.type)"
    echo "compiled   : $(cat /etc/version.date 2>/dev/null)"
    echo "openwrt    : $(cat /etc/openwrt_version 2>/dev/null)"
    echo "boot slot  : $(/sbin/abctl --boot_slot 2>/dev/null)"
    echo "uptime     : $(uptime)"
    echo
    echo "=== mounts ==="; df -h
    echo
    echo "=== partitions ==="; ls -l /dev/block/bootdevice/by-name/ 2>/dev/null
    echo
    echo "=== running services ==="; ls /etc/rc.d/ | sort
    echo
    echo "=== installed packages ==="; opkg list-installed 2>/dev/null | wc -l
' 2>&1 | quiet > "$DEST/device-state.txt"

# --- 2. the overlay: everything that is not stock -------------------------
echo "[2/5] overlay (all runtime changes)"
$SSH 'tar -C /overlay -cf - . 2>/dev/null' 2>/dev/null > "$DEST/overlay.tar"

# --- 3. configuration, in a form that is readable without unpacking --------
echo "[3/5] uci configuration"
$SSH 'for f in /etc/config/*; do echo "########## $f"; cat "$f"; echo; done' 2>&1 | quiet > "$DEST/etc-config.txt"
$SSH 'uci -q show 2>/dev/null' 2>&1 | quiet > "$DEST/uci-show.txt"

# --- 4. the exact files this package replaces ------------------------------
# If one of them turns out to break something, this is what gets copied back.
echo "[4/5] the files the package overwrites"
REPLACED="
/usr/sbin/gl-ngx-session
/usr/share/gl-ngx/oui-rpc.lua
/www/views/gl-sdk4-ui-internet.common.js.gz
/www/views/gl-sdk4-ui-login.common.js.gz
/www/views/gl-sdk4-ui-wireless.common.js.gz
/www/views/gl-sdk4-ui-cellular-detail.common.js.gz
/etc/dropbear/authorized_keys
"
for f in $REPLACED; do
    out="$DEST/files/$(echo "${f#/}" | tr '/' '_')"
    if $SSH "test -f $f" 2>/dev/null; then
        $SSH "cat $f" 2>/dev/null > "$out"
        printf "  %-52s %s bytes\n" "$f" "$(wc -c < "$out" | tr -d ' ')"
    else
        printf "  %-52s absent\n" "$f"
    fi
done

# --- 5. checksums, so a restore can be proven ------------------------------
echo "[5/5] checksums"
$SSH "for f in $(echo $REPLACED | tr '\n' ' '); do [ -f \$f ] && md5sum \$f; done" 2>&1 | quiet > "$DEST/replaced.md5"
( cd "$DEST" && find . -type f -exec shasum -a 256 {} \; | sort -k2 > SHA256SUMS )

echo
echo "backup complete: $DEST"
du -sh "$DEST"
ls -la "$DEST"
