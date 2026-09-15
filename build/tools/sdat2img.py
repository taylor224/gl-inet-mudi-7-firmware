#!/usr/bin/env python3
"""Reconstruct a raw ext4 image from an Android block-OTA pair
(system.transfer.list + system.new.dat).

Supports transfer-list versions 1-4. Only the commands that can appear in a
full (non-incremental) package are honoured: `new` supplies data, `erase` and
`zero` only extend the image, everything else is ignored.
"""
import sys

BLOCK = 4096


def parse_ranges(text):
    nums = [int(x) for x in text.split(',')]
    count = nums[0]
    pairs = nums[1:]
    if count != len(pairs):
        raise ValueError("range count %d does not match %d values" % (count, len(pairs)))
    return [(pairs[i], pairs[i + 1]) for i in range(0, count, 2)]


def main(list_path, dat_path, img_path):
    lines = open(list_path).read().splitlines()
    version = int(lines[0])
    total_blocks = int(lines[1])
    body = lines[4:] if version >= 2 else lines[2:]

    commands = []
    max_block = 0
    for line in body:
        line = line.strip()
        if not line:
            continue
        op, _, rest = line.partition(' ')
        if op not in ('new', 'erase', 'zero'):
            continue
        ranges = parse_ranges(rest)
        for _, end in ranges:
            max_block = max(max_block, end)
        if op == 'new':
            commands.append(ranges)

    print("transfer list v%d  total_blocks=%d  image_blocks=%d (%.1f MB)"
          % (version, total_blocks, max_block, max_block * BLOCK / 1048576))

    with open(img_path, 'wb') as img:
        img.truncate(max_block * BLOCK)
        with open(dat_path, 'rb') as dat:
            for ranges in commands:
                for start, end in ranges:
                    img.seek(start * BLOCK)
                    remaining = (end - start) * BLOCK
                    while remaining:
                        chunk = dat.read(min(remaining, 1 << 22))
                        if not chunk:
                            raise EOFError("%s ended early; image is incomplete" % dat_path)
                        img.write(chunk)
                        remaining -= len(chunk)

    print("wrote %s" % img_path)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit("usage: sdat2img.py <transfer.list> <new.dat> <out.img>")
    main(*sys.argv[1:])
