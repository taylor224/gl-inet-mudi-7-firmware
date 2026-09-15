#!/bin/bash
# Push a slim package to the e5800 and start the A/B update.
#
#   ./flash.sh out/e5800-slim-full-*.zip            dry run: checks only
#   ./flash.sh out/e5800-slim-full-*.zip --yes      actually flash
#
# The device does not run SSH on 22. Each unit gets its own port: read it from
# the admin panel under System > Advanced, or with
#   ubus call local-access status
# then pass --port, or set SSH_PORT.
#
# The update lands on the INACTIVE slot. The slot you are running now is left
# untouched until the new one boots successfully, so a bad package costs a
# reboot, not the device. It still writes to internal storage -- read the
# preflight output before passing --yes.

set -euo pipefail

ZIP=${1:-}
HOST=${HOST:-192.168.8.1}
PORT=${SSH_PORT:-}
SSH_USER=${SSH_USER:-root}
# Key auth only: this script runs unattended and must never stop on a prompt.
SSH_KEY=${SSH_KEY:-}
CONFIRM=0

[ -n "$ZIP" ] || { sed -n '2,12p' "$0"; exit 2; }
shift
while [ $# -gt 0 ]; do
    case "$1" in
        --yes) CONFIRM=1; shift ;;
        --host) HOST=$2; shift 2 ;;
        --port) PORT=$2; shift 2 ;;
        --key) SSH_KEY=$2; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

[ -f "$ZIP" ] || { echo "no such package: $ZIP" >&2; exit 1; }
SIZE=$(wc -c < "$ZIP")
[ -n "$PORT" ] || { echo "ssh port required -- pass --port or set SSH_PORT (see the header)" >&2; exit 2; }
[ -n "$SSH_KEY" ] || { echo "ssh key required -- pass --key or set SSH_KEY" >&2; exit 2; }

SSH_OPTS="-p $PORT -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o IdentitiesOnly=yes -i $SSH_KEY"
SSH="ssh $SSH_OPTS $SSH_USER@$HOST"

[ -f "$SSH_KEY" ] || { echo "no ssh key at $SSH_KEY -- pass --key or set SSH_KEY" >&2; exit 1; }

echo "package : $ZIP ($(( SIZE / 1048576 )) MB)"
echo "device  : $SSH_USER@$HOST:$PORT"
echo

echo "--- preflight ---"
$SSH "
    echo \"model     : \$(cat /proc/gl-hw-info/model 2>/dev/null || echo unknown)\"
    echo \"firmware  : \$(cat /etc/glversion) build \$(cat /etc/version.build)\"
    echo \"boot slot : \$(/sbin/abctl --boot_slot)\"
    echo 'space for the package:'
    df -h /cache/ufs 2>/dev/null | tail -1
"

# The package lands in /cache/ufs, which is a different partition mounted over
# /cache -- 1.3G on this unit against 41M for /cache itself. Measuring the
# wrong one makes a fitting package look far too big.
# df columns are: Filesystem 1K-blocks Used Available Use% Mounted-on
FREE=$($SSH "df -k /cache/ufs | tail -1 | awk '{print \$(NF-2)}'")
NEED=$(( SIZE / 1024 + 4096 ))
case "$FREE" in
    ''|*[!0-9]*) echo "could not read free space on /cache (got '$FREE')" >&2; exit 1 ;;
esac
echo
echo "need ${NEED} KB in /cache, have ${FREE} KB"
[ "$FREE" -ge "$NEED" ] || { echo "not enough free space in /cache" >&2; exit 1; }

if [ "$CONFIRM" != 1 ]; then
    echo
    echo "dry run only. Re-run with --yes to copy and flash."
    exit 0
fi

echo
echo "--- copying ---"
$SSH "mkdir -p /cache/ufs && rm -f /cache/ufs/update.zip"
# -O forces the legacy SCP protocol. OpenSSH 9 defaults to SFTP, and dropbear
# on this device ships no sftp-server, so the transfer dies with
# "ash: /usr/libexec/sftp-server: not found" without it.
scp -O -P "$PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o IdentitiesOnly=yes \
    -i "$SSH_KEY" "$ZIP" "$SSH_USER@$HOST:/cache/ufs/update.zip"

LOCAL_SHA=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
REMOTE_SHA=$($SSH "sha256sum /cache/ufs/update.zip | cut -d' ' -f1")
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] || { echo "transfer corrupted: $LOCAL_SHA != $REMOTE_SHA" >&2; exit 1; }
echo "sha256 verified on device"

# --- keep the device's settings ------------------------------------------
#
# This is the step whose absence factory-reset the device once already.
#
# abfota_update only backs up user configuration when it is told to, and the
# switch is its second argument:
#
#   abfota_update:801   if [ $2 = '-k' ]; then KEEPCFGUPDATE="true"
#                                              mkdir -p /etc/ab_keep_cfg
#
# Without it, GetAbNootaFileList looks for quectel_ab_noota_filelist.txt inside
# the package instead of building the list from /lib/upgrade/keep.d, finds
# nothing, and BackupUserConfigurationsBeforeUpdate logs "skip backup!" and
# returns. The overlay is then cleared on the next boot with an empty backup to
# restore from -- every setting, key and password gone.
#
# So: assert the keep list exists, set the marker file directly as well as
# passing the flag (GetAbNootaFileList honours either), and refuse to flash if
# the precondition is missing.
echo
echo "--- settings preservation ---"
KEEP_COUNT=$($SSH "ls /lib/upgrade/keep.d/ 2>/dev/null | wc -l" | tr -d ' \r')
echo "entries in /lib/upgrade/keep.d: ${KEEP_COUNT:-0}"
case "${KEEP_COUNT:-0}" in
    ''|*[!0-9]*|0)
        echo "refusing to flash: /lib/upgrade/keep.d is empty or unreadable," >&2
        echo "so nothing would preserve this device's settings." >&2
        exit 1
        ;;
esac
$SSH "mkdir -p /etc/ab_keep_cfg" || { echo "could not create /etc/ab_keep_cfg" >&2; exit 1; }
$SSH "test -d /etc/ab_keep_cfg" || { echo "/etc/ab_keep_cfg is missing after creating it" >&2; exit 1; }
echo "keep-config marker in place, and -k will be passed as well"

echo
echo "--- validating the package on the device ---"
# -T is the vendor's own test mode: it runs ValidateFotaPackage and stops.
$SSH "fotainfo -p update.zip && abfota_update start-fota -T" 2>&1 | sed 's/^/  /'

echo
echo "--- flashing ---"
FLASH_LOG=$(mktemp)
$SSH "abfota_update start-fota -k" 2>&1 | tee "$FLASH_LOG" | sed 's/^/  /'

echo
echo "--- did it actually back up the settings? ---"
if grep -q "skip backup" "$FLASH_LOG"; then
    echo "*** THE SETTINGS WERE NOT BACKED UP ***" >&2
    echo "abfota_update logged \"skip backup!\". When this device reboots it will" >&2
    echo "come up factory reset. Restore from build/backup/<stamp>/overlay.tar." >&2
    rm -f "$FLASH_LOG"
    exit 1
elif grep -q "Backup user configurations before update" "$FLASH_LOG"; then
    echo "confirmed: settings were backed up before the write"
else
    echo "WARNING: no backup message either way -- check the log below" >&2
fi
rm -f "$FLASH_LOG"

echo
echo "--- update log ---"
$SSH "tail -40 /cache/fota/abfota_script.log 2>/dev/null; cat /cache/recovery/ota_status 2>/dev/null"
echo
echo "If ota_status reads OTA_SUCCESS, reboot into the new slot: $SSH reboot"
