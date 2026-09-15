#!/usr/bin/env python3
"""Turn a raw ext4 system image into a system-only A/B OTA staging tree.

Emits, under <staging>:
    system.new.dat
    system.transfer.list
    system.patch.dat                      (always empty)
    META-INF/com/google/android/update-binary   (copied from the stock package)
    META-INF/com/google/android/updater-script
    META-INF/com/android/metadata

Two write modes:

  full    every block in the image is written with `new`. The script can then
          verify the whole span with a single range_sha1, so a bad flash is
          caught. The .dat is image-sized, but its zero regions deflate away
          inside the zip.

  sparse  only large all-zero regions are skipped and covered by `erase`,
          mirroring what the stock package does. Smaller .dat.

          The threshold matters. Small zero runs are ordinary file content and
          filesystem metadata -- skipping those would leave the previous slot's
          data in blocks the new filesystem believes are zeroed. Only runs of
          at least --min-gap blocks are treated as unallocated. At the default
          of 4096 blocks (16 MB) this image yields exactly the two holes the
          stock package erases, [70086,98304) and [131073,163840), each of
          which contains the stock erase range.

          Erased blocks read back as whatever the storage returns after
          discard, so they are excluded from verification.

Only the transfer-list commands this device's updater actually dispatches are
used: its command table holds bsdiff/erase/free/imgdiff/move/new/stash, with no
`zero` entry.
"""
import argparse
import hashlib
import os
import shutil
import sys
import time

BLOCK = 4096
CHUNK_BLOCKS = 1024          # blocks per `new` command, matching the stock list
SYSTEM_DEV = "/dev/block/bootdevice/by-name/system"
MAX_RANGE_INTS = 60          # keep the verify line to a sane length


def scan_blocks(path):
    """Return (block_count, [(start, end), ...]) for runs of non-zero blocks."""
    size = os.path.getsize(path)
    if size % BLOCK:
        raise SystemExit("image size %d is not a multiple of %d" % (size, BLOCK))
    total = size // BLOCK
    zero = b'\0' * BLOCK
    runs = []
    start = None
    index = 0
    with open(path, 'rb') as f:
        while True:
            buf = f.read(BLOCK * 256)
            if not buf:
                break
            for off in range(0, len(buf), BLOCK):
                block = buf[off:off + BLOCK]
                if block != zero:
                    if start is None:
                        start = index
                elif start is not None:
                    runs.append((start, index))
                    start = None
                index += 1
    if start is not None:
        runs.append((start, total))
    return total, runs


def chunk(ranges):
    """Split ranges so no single command covers more than CHUNK_BLOCKS."""
    out = []
    for start, end in ranges:
        cursor = start
        while cursor < end:
            stop = min(cursor + CHUNK_BLOCKS, end)
            out.append((cursor, stop))
            cursor = stop
    return out


def coalesce(runs, min_gap):
    """Merge runs separated by a gap smaller than min_gap.

    A short zero run inside the filesystem is real content, not free space, so
    it has to be written rather than erased.
    """
    if not runs:
        return []
    merged = [list(runs[0])]
    for start, end in runs[1:]:
        if start - merged[-1][1] < min_gap:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged]


def invert(total, runs):
    """Ranges of `total` blocks not covered by `runs`."""
    gaps = []
    cursor = 0
    for start, end in runs:
        if start > cursor:
            gaps.append((cursor, start))
        cursor = end
    if cursor < total:
        gaps.append((cursor, total))
    return gaps


def range_string(ranges):
    values = []
    for start, end in ranges:
        values.extend((start, end))
    return "%d,%s" % (len(values), ",".join(str(v) for v in values))


def write_dat(img_path, dat_path, ranges):
    written = 0
    with open(img_path, 'rb') as img, open(dat_path, 'wb') as dat:
        for start, end in ranges:
            img.seek(start * BLOCK)
            remaining = (end - start) * BLOCK
            while remaining:
                buf = img.read(min(remaining, 1 << 22))
                if not buf:
                    raise SystemExit("image ended early at block %d" % start)
                dat.write(buf)
                remaining -= len(buf)
                written += len(buf)
    return written


def sha1_of_ranges(img_path, ranges):
    digest = hashlib.sha1()
    with open(img_path, 'rb') as img:
        for start, end in ranges:
            img.seek(start * BLOCK)
            remaining = (end - start) * BLOCK
            while remaining:
                buf = img.read(min(remaining, 1 << 22))
                if not buf:
                    raise SystemExit("image ended early during hashing")
                digest.update(buf)
                remaining -= len(buf)
    return digest.hexdigest()


UPDATER_HEAD = '''ui_print("=== e5800 system-only package ===");
ui_print("Mode: {mode}   Blocks: {total}");
show_progress(1.000000, 0);
set_progress(0.000000);

set_inactive_slot_as_unbootable() || abort("Failed to set inactive slot as unbootable!");

ui_print("Copying every partition except system to the inactive slot...");
copy_all_source_partitions_except("system") ||
  abort("E3009: Failed to copy partitions from active to inactive slot");
set_progress(0.200000);

ui_print("Writing system image...");
block_image_update("{dev}", package_extract_file("system.transfer.list"), "system.new.dat", "system.patch.dat") ||
  abort("E1001: Failed to update system image.");
set_progress(0.900000);
'''

UPDATER_VERIFY = '''
ui_print("Verifying the updated system image...");
if range_sha1("{dev}", "{ranges}") == "{sha1}" then
ui_print("Verified the updated system image.");
else
  abort("E1002: system partition has unexpected contents after OTA update");
endif;
'''

UPDATER_NOVERIFY = '''
ui_print("Post-write verification skipped ({reason}).");
'''

UPDATER_TAIL = '''set_progress(1.000000);
ui_print("Done. The device will boot the updated slot.");
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image", help="patched raw ext4 system image")
    ap.add_argument("staging", help="directory to build the package tree in")
    ap.add_argument("--stock", required=True,
                    help="stock package directory, for META-INF/.../update-binary")
    ap.add_argument("--mode", choices=("full", "sparse"), default="full")
    ap.add_argument("--min-gap", type=int, default=4096,
                    help="sparse mode: smallest zero run treated as free space, "
                         "in 4 KB blocks (default 4096 = 16 MB)")
    args = ap.parse_args()

    stock_binary = os.path.join(args.stock, "META-INF", "com", "google", "android", "update-binary")
    if not os.path.isfile(stock_binary):
        raise SystemExit("update-binary not found at %s" % stock_binary)

    print("scanning %s ..." % args.image)
    total, runs = scan_blocks(args.image)
    nonzero = sum(end - start for start, end in runs)
    print("  %d blocks total, %d non-zero (%.1f%%)"
          % (total, nonzero, 100.0 * nonzero / total))

    if args.mode == "full":
        new_ranges = chunk([(0, total)])
        erase_ranges = []
        verify_ranges = [(0, total)]
        verify_reason = None
    else:
        merged = coalesce(runs, args.min_gap)
        erase_ranges = invert(total, merged)
        skipped = sum(end - start for start, end in erase_ranges)
        print("  %d free regions of >=%d blocks, %.0f MB erased instead of written"
              % (len(erase_ranges), args.min_gap, skipped * BLOCK / 1048576))
        for start, end in erase_ranges:
            print("    erase [%d,%d)" % (start, end))
        new_ranges = chunk(merged)
        if len(merged) * 2 <= MAX_RANGE_INTS:
            verify_ranges = merged
            verify_reason = None
        else:
            verify_ranges = None
            verify_reason = "%d written regions exceed the edify line budget" % len(merged)

    if os.path.isdir(args.staging):
        shutil.rmtree(args.staging)
    meta_dir = os.path.join(args.staging, "META-INF", "com", "google", "android")
    os.makedirs(meta_dir)
    os.makedirs(os.path.join(args.staging, "META-INF", "com", "android"))

    dat_path = os.path.join(args.staging, "system.new.dat")
    print("writing system.new.dat ...")
    written = write_dat(args.image, dat_path, new_ranges)
    print("  %.1f MB" % (written / 1048576))

    new_blocks = sum(end - start for start, end in new_ranges)
    lines = ["3", str(new_blocks), "0", "0"]
    if erase_ranges:
        lines.append("erase " + range_string(erase_ranges))
    for start, end in new_ranges:
        lines.append("new " + range_string([(start, end)]))
    list_path = os.path.join(args.staging, "system.transfer.list")
    with open(list_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("writing system.transfer.list ... %d commands" % (len(lines) - 4))

    open(os.path.join(args.staging, "system.patch.dat"), "wb").close()

    script = UPDATER_HEAD.format(mode=args.mode, total=total, dev=SYSTEM_DEV)
    if verify_ranges:
        print("hashing verification ranges ...")
        digest = sha1_of_ranges(args.image, verify_ranges)
        script += UPDATER_VERIFY.format(dev=SYSTEM_DEV,
                                        ranges=range_string(verify_ranges),
                                        sha1=digest)
        print("  sha1 %s" % digest)
    else:
        script += UPDATER_NOVERIFY.format(reason=verify_reason)
        print("  verification skipped: %s" % verify_reason)
    script += UPDATER_TAIL

    with open(os.path.join(meta_dir, "updater-script"), "w") as f:
        f.write(script)
    shutil.copy2(stock_binary, os.path.join(meta_dir, "update-binary"))
    os.chmod(os.path.join(meta_dir, "update-binary"), 0o755)

    with open(os.path.join(args.staging, "META-INF", "com", "android", "metadata"), "w") as f:
        f.write("ota-required-cache=0\n")
        f.write("ota-type=BLOCK\n")
        f.write("post-build=e5800-slim\n")
        f.write("post-timestamp=%d\n" % int(time.time()))
        f.write("pre-device=e5800\n")
        f.write("system_image_size=%d\n" % written)

    print("staging tree ready at %s" % args.staging)


if __name__ == "__main__":
    main()
