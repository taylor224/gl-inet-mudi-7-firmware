# e5800 slim package builder

Builds a **system-only** A/B OTA package for the GL.iNet e5800. It rewrites the
`system` partition on the inactive slot and copies every other partition across
from the active one — the bootloader, TrustZone, hypervisor and modem images
are never written from the package.

```
./build.sh                    # full mode, verified after write
./build.sh --mode sparse      # skip large free regions, smaller package
./build.sh --reunpack         # rebuild the pristine image from the stock package
./flash.sh out/<package>.zip  # preflight only
./flash.sh out/<package>.zip --yes
```

## Layout

```
build/
├── build.sh              orchestrator
├── flash.sh              SSH deploy, dry run unless --yes
├── patch/                your changes, mirroring the rootfs
├── tools/
│   ├── sdat2img.py       stock system.new.dat -> raw ext4 image
│   ├── patch_image.sh    loop-mount the image in Docker, apply patch/
│   └── mkpackage.py      image -> new.dat + transfer.list + META-INF
├── work/                 generated: pristine + working image, staging tree
└── out/                  generated: the package zip
```

`work/system.pristine.img` is unpacked once and kept. Every build starts from a
fresh copy of it, so patches never stack — remove a file from `patch/` and it is
gone from the next build.

## How a change gets in

Drop files into `patch/`, mirroring the rootfs. The image is loop-mounted inside
an `alpine:3.20` container and the tree is copied in with `cpio -pdmu`, which
preserves symlinks and modes; ownership is forced to `root:root`. macOS cannot
mount ext4, and unpacking with 7-Zip loses symlinks, permissions and ownership,
so the image is never unpacked and repacked — only patched in place.

Docker must be running, and the container needs `--privileged` for the loop
mount.

## Write modes

| | `full` (default) | `sparse` |
|---|---|---|
| Blocks written | every block, 0..202240 | everything except large free regions |
| `.dat` size | 790 MB | 552 MB |
| Zip size | **179 MB** | **178 MB** |
| Post-write check | `range_sha1` over the whole span | `range_sha1` over the written regions |

Measured on this firmware. Sparse saves 238 MB in the `.dat` and 1 MB in the
package, because the blocks it skips are zeros and deflate to nothing anyway.
So `full` is the default: it costs a megabyte and leaves nothing on the
partition from the previous slot.

Sparse mode only skips zero runs of at least `--min-gap` blocks (default 4096,
i.e. 16 MB). This threshold is not cosmetic. Short zero runs are ordinary file
content and filesystem metadata; erasing those would leave the previous slot's
data in blocks the new filesystem believes are zeroed. At the default the two
regions it skips, `[70086,98304)` and `[131073,163840)`, each contain the
corresponding range from the stock package's own `erase` command.

## The generated updater-script

Only edify functions present in this device's `update-binary` are used, and only
transfer-list commands its dispatch table actually holds — `bsdiff`, `erase`,
`free`, `imgdiff`, `move`, `new`, `stash`. There is **no `zero` entry**, which is
why free space is handled with `erase` rather than `zero`.

```
set_inactive_slot_as_unbootable()
copy_all_source_partitions_except("system")
block_image_update("/dev/block/bootdevice/by-name/system", ...)
range_sha1(...) == "<sha1>"      -- else abort
```

## Flashing

`flash.sh` copies the package to `/cache/ufs/update.zip`, re-checks its SHA-256
on the device, then runs `fotainfo -p` and `abfota_update start-fota`. That path
does not consult `/etc/key-build.pub`; the usign check lives only in the web
UI's `check_firmware_local` handler.

The update targets the inactive slot. The running slot is untouched until the
new one boots and `ab-updater.init` calls `abctl --set_success`, so a bad
package costs a reboot rather than the device. That safety net does not extend
to packages that write bootloader or TrustZone partitions — this builder never
does, and neither should any variant of it.

`work/staging/` is left in place after a build so the generated
`updater-script` and `system.transfer.list` can be read. It is rebuilt from
scratch each time.

Keep the stock package. It is the way back.
