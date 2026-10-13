# GL-E5800 (Mudi 7) firmware modifications

Tooling and patches that add four features to the stock GL.iNet GL-E5800
firmware, plus the builder that turns them into a flashable A/B OTA package.

Everything here is built on top of a stock vendor package. No vendor firmware,
image or bundle is redistributed in this repository — see
[What is not here](#what-is-not-here).

Developed against stock firmware `4.10.0_release5-1092` on a GL-E5800 fitted
with a Quectel RG650V modem.

---

## Disclaimer

**Flashing modified firmware will likely void your warranty, and may leave the
device not working correctly or not working at all.**

- GL.iNet does not support modified firmware. Applying anything built here is
  very likely to void the manufacturer's warranty, and support may be refused
  for a device that has run it.
- The device may misbehave or stop working. The cellular features below drive
  the modem directly, and a bad lock can leave a router with no data service
  until it is cleared by hand. The Wi-Fi feature disconnects clients on
  purpose. Both are off by default; turning them on is your decision.
- This is unofficial, unaffiliated work, provided with no warranty of any kind,
  express or implied. Nobody involved is liable for damage, data loss, an
  unusable device, or missed connectivity.
- Recovery is your responsibility. Keep the stock vendor package and a backup
  of the device overlay (`build/backup.sh`) before you flash anything. Know how
  to recover your specific unit before you start.
- Radio behaviour is regulated. Locking a modem to a cell, or forcing clients
  off an access point, may be restricted where you live. Using this on a
  network you do not own or administer may also breach your carrier's terms.

Use at your own risk.

---

## What it adds

### 1. Excluded Towers

A cell blacklist for the cellular modem, with a page in the admin panel.

The modem has no "avoid this cell" command. `AT+QNWLOCK` only pins the radio
*to* a cell, so exclusion is built on top of it: a daemon reads the serving
cell and its neighbours every few seconds, and when the modem lands on an
excluded cell it locks onto the best allowed neighbour instead.

Acting is expensive. Every `AT+QNWLOCK` write, an unlock included, restarts
the radio — the modem drops to low-power mode and back, and the data call ends
— so the daemon is built around writing as rarely as it can:

- Escapes are rationed. Each attempt counts against a budget that decays on a
  timer rather than resetting whenever the serving cell changes, so a modem
  bouncing between two cells cannot spend the budget repeatedly.
- Candidates must clear a signal floor, and the serving cell is excluded from
  its own neighbour list, so a lock is never issued to a cell the modem cannot
  hold or to where it already is.
- Locks, escapes included, go only to cells this SIM has camped on before. A
  neighbour list is not filtered by operator, so on a dual-SIM router the other
  SIM's cells sit in it looking like fine candidates; a lock to one can only
  end on 3G. With no known cell in range, the modem is left on the excluded
  cell rather than locked to nothing.
- Where the modem accepts a multi-cell lock, every lock pins a list of allowed
  cells rather than one, so the modem can still hand over between them.
- A voluntary switch that fails suspends switching for the same decay period
  as the escape budget, instead of trying the next candidate two minutes later.
- An unlock writes only the lock form (4G or 5G) that is actually set, so
  letting go costs one restart, not two.
- A lock is released when it is no longer needed: the signal falls away, the
  modem drops to 3G, the excluded cell leaves the blacklist, the feature is
  switched off, or the service stops.

Scoring is a throughput proxy — signal, plus signal quality, plus a bonus for
5G, plus aggregate carrier bandwidth. Bandwidth is only reported for the cell
the modem is camped on, so it is learned and cached per operator and cell, and
a neighbour seen before is scored with the width measured then. The cache keeps
the widest reading, and the serving cell is scored on its cached width too:
secondary carriers are only listed while data is flowing, so an idle modem
under-reports its own cell and would otherwise lose to any neighbour remembered
from a busy moment.

Three things about this modem family turned out to matter, and are handled:

| | |
|---|---|
| `AT+QENG="servingcell"` in 5G NSA | Answers on **three** lines — a header, an LTE anchor line, and an `NR5G-NSA` line — not the single line an LTE-only attach returns. A parser that knows only the single-line form sees no serving cell at all while the modem is on 5G, which every safety rule then reads as "the lock killed service". |
| `AT+QNWLOCK` on a dual-SIM unit | Lock state belongs to the **SIM subscription it was set on**. A lock left on the standby slot is invisible from the active slot, survives indefinitely, and takes effect again the moment a failover makes that slot active — pinning the modem to a cell it may no longer reach. Both slots are swept, and the standby slot again every minute: a failover restarts the radio, and a sweep that asks while it is down gets no answer. |
| `AT+QCAINFO` units | LTE carrier width arrives in resource blocks, NR width as a bandwidth index, and neither is MHz. Unconverted, a 15 MHz carrier scores as though it were 75. |

A lock outlives the process that set it, so the daemon also adopts any lock it
finds but did not issue — at startup, immediately when the connection is
already in trouble, and otherwise on a periodic check — and then releases it
under the normal rules. Without that, a lock left by a crash, a restart or an
earlier version is one nothing can undo.

Config: `/etc/config/cellguard`. Daemon: `gl_cellguard` (`run`, `once`,
`probe`, `selftest`, `unlock`, `release`). `probe` dumps the raw modem
responses per SIM slot so field positions can be confirmed against the modem
actually fitted; `selftest` runs the parsers against recorded response
fixtures.

### 2. Minimum RSSI

Disconnects Wi-Fi clients whose signal stays below a floor, so they roam
somewhere better instead of holding airtime at the lowest rate.

Signal comes from `iwinfo assoclist`, which does not disturb the link.
Disconnection goes through `hostapd_cli`. Two details decide whether this helps
or hurts, and both are configurable: a client must be under the floor for
several consecutive polls, because RSSI swings a few dB between samples; and a
disconnected client is briefly denied, because otherwise it re-associates to
the same access point within a second and nothing is achieved. Clients get a
grace period after associating, and specific MACs can be exempted.

On a single-AP network a disconnected client simply loses service for the ban
period. That is the intended behaviour when the floor means "below this,
service is not worth having", and a trap otherwise.

Config: `/etc/config/rssiguard`. Daemon: `gl_rssiguard`.

### 3. Remember this device

A "remember this device" option on the login page, so a trusted browser is not
asked for the admin password on every visit.

Sessions live in memory and die with the daemon, so this could not be built by
lengthening the session timeout — a reboot would forget everyone. It is a
separate credential:

- The token is `<id>.<secret>`. Only a **hash of the secret** is stored on the
  device, so the file leaking does not hand anyone a login.
- The cookie is `HttpOnly` — the page never needs to read the token, only to
  send it — and `SameSite=Lax`, so another site cannot silently resume the
  session in a hidden request.
- Signing out explicitly forgets the browser. Records expire, and are pruned.
- A rejected token clears the cookie; a transient backend failure does not, so
  a blip does not sign everyone out.

Along the way this fixed a real bug in the stock session handler: a cookie name
was interpolated straight into a Lua pattern, where `-` is a quantifier rather
than a literal. `Remember-Token=([%w%.]+)` can never match `Remember-Token=`,
so every read silently returned nil. The write path used `string.format` and
worked, which hid it.

### 4. Front panel layout override

The device's screen layout is compiled into the `gl_screen` binary, but four
layout layers are loaded in order and the last definition wins. A product-layer
file is shipped so element positions, sizes and colours can be overridden
without touching the binary. Values are absolute, not deltas.

---

## The builder

`build/build.sh` produces a **system-only** A/B OTA package. It rewrites the
`system` partition on the inactive slot and copies every other partition across
from the active one — bootloader, TrustZone, hypervisor and modem images are
never written from the package.

The update lands on the inactive slot, and the running slot is untouched until
the new one boots successfully, so a bad package costs a reboot rather than the
device. That safety net does not extend to packages that write bootloader or
TrustZone partitions. This builder never does, and neither should any variant
of it.

```
build/build.sh                    # full mode, verified after write
build/build.sh --mode sparse      # skip large free regions, smaller package
build/flash.sh out/<package>.zip  # preflight only
build/flash.sh out/<package>.zip --port <ssh port> --key <ssh key> --yes
```

macOS cannot mount ext4 and unpacking with a generic archiver loses symlinks,
permissions and ownership, so the image is never unpacked and repacked. It is
loop-mounted inside a container and patched in place. Docker must be running,
and the container needs `--privileged` for the loop mount.

`build/README.md` documents the write modes, the generated updater-script and
the flashing path in detail.

### Web UI toolchain

The stock admin panel ships as minified, gzipped Vue bundles. `build/webui/`
holds a small pipeline for working on them: extract from a rootfs, de-minify,
edit, verify the result still parses and keeps the same exports, then repack to
`.js.gz` straight into the patch tree.

New user-facing strings go in their own i18n namespace rather than into the
vendor's files. `/www/i18n` is read with a directory traversal matching
`<anything>.<locale>.json`, so a new namespace is added by dropping files in.
Because vue-i18n's locale fallback cannot help with a namespace that was never
loaded, the English text is written for all seven shipped locales, and real
translations can replace individual files later.

`build/webui/serve/` runs the panel against RPC mocks in a browser, so the new
pages can be worked on without a device.

### Backup

`build/backup.sh` snapshots what a rollback needs before you write anything.
The stock system partition is not pulled — the pristine image unpacked from the
vendor package already is one. What is not reproducible from that package is
the overlay: every setting, key and change made since the device left the
factory. That is what it collects.

---

## Layout

```
build/
├── build.sh              orchestrator
├── flash.sh              SSH deploy, dry run unless --yes
├── backup.sh             pull the device overlay before flashing
├── tools/
│   ├── sdat2img.py       stock system.new.dat -> raw ext4 image
│   ├── patch_image.sh    loop-mount the image in Docker, apply patch/
│   └── mkpackage.py      image -> new.dat + transfer.list + META-INF
├── patch/                new files, mirroring the rootfs
│   ├── etc/config/       cellguard, rssiguard defaults (both off)
│   ├── etc/init.d/       procd services
│   ├── usr/bin/          gl_cellguard, gl_rssiguard
│   ├── usr/lib/oui-httpd/rpc/    RPC modules for the two panel pages
│   ├── usr/share/gl-validator.d/ config validators
│   └── www/i18n/         new i18n namespaces, seven locales
├── patches/              unified diffs against vendor files
│   ├── backend/          session handler and RPC layer
│   └── webui/            four view bundles
└── webui/                extract / de-minify / verify / repack pipeline
```

---

## Building it yourself

You need the stock vendor OTA package for your device and firmware version, a
running Docker, Node, and Python 3.

1. Unpack the stock package beside this repository as `e5800-<version>/`.
2. Regenerate the vendor-derived files, which are not distributed here:
   ```
   cd build/webui
   npm install
   tools/extract.sh <path to a stock rootfs>   # -> orig/
   npm run beautify                            # -> base/
   cp -r base src
   for p in ../patches/webui/*.patch; do patch -p1 -d src < "$p"; done
   npm run verify && npm run pack              # -> ../patch/www/views/
   node tools/i18n.mjs                         # -> ../patch/www/i18n/
   ```
   Then the two backend files, copied out of a stock rootfs first:
   ```
   cp <rootfs>/usr/share/gl-ngx/oui-rpc.lua build/patch/usr/share/gl-ngx/
   cp <rootfs>/usr/sbin/gl-ngx-session       build/patch/usr/sbin/
   patch -p1 -d build/patch/usr/share/gl-ngx < build/patches/backend/oui-rpc.lua.patch
   patch -p1 -d build/patch/usr/sbin         < build/patches/backend/gl-ngx-session.patch
   ```
3. `build/build.sh`
4. Back the device up, read the preflight output, then flash.

Both new features ship **disabled**. Turn them on from their admin panel pages
or in `/etc/config/`.

---

## What is not here

Deliberately excluded, and ignored by git:

- **The stock firmware package.** GL.iNet, Qualcomm and Quectel property, about
  a gigabyte of it. Get it from the vendor.
- **Vendor web UI bundles and backend Lua**, in original or modified form. Only
  unified diffs against them are published, under `build/patches/`.
- **Strings and key tables extracted from the vendor `gl_screen` binary.**
- **Build products** — unpacked images, staging trees, packages.
- **Device backups.** An overlay snapshot contains keys, credentials and
  network configuration.

No device identifiers, subscriber identifiers, keys or credentials are
committed. Test fixtures keep the exact response layouts the parsers depend on,
but every subscriber-side value in them is a test value: PLMN 001 (reserved by
the ITU for testing), invented cell identities, placeholder area codes, made-up
network names, and locally administered hardware addresses. Channel numbers and
signal levels are left plausible so the bandwidth and scoring arithmetic stays
meaningful. Measurements quoted in code comments describe the behaviour
observed, not the cells, SIMs or operators involved.

## Licence

GPL-2.0-or-later — see [LICENSE](LICENSE). The patches apply to GPL'd OpenWrt
userland and to vendor code whose licence is the vendor's to state; they are
published for interoperability and for people working on their own hardware.

Not affiliated with, endorsed by, or supported by GL.iNet.
