// Package edited views for the firmware image.
//
// nginx serves /www/views with `gzip_static on` and the stock image ships only
// `.js.gz` files, so that is what we write. The de-minified source stays
// readable on disk; gzip absorbs most of the size it costs.
//
// Output goes straight into build/patch/, which build.sh copies into the image.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATCH_VIEWS = join(HERE, '..', 'patch', 'www', 'views');

const requested = process.argv.slice(2);
const views =
  requested.length > 0
    ? requested
    : (await readdir(join(HERE, 'src')))
        .filter((f) => f.endsWith('.js'))
        .map((f) => basename(f, '.js'))
        .sort();

await mkdir(join(HERE, 'dist'), { recursive: true });
await mkdir(PATCH_VIEWS, { recursive: true });

for (const view of views) {
  const src = await readFile(join(HERE, 'src', `${view}.js`), 'utf8');
  const base = await readFile(join(HERE, 'base', `${view}.js`), 'utf8').catch(() => null);

  if (base !== null && base === src) {
    console.log(`${view.padEnd(17)} unchanged, not packed`);
    continue;
  }

  const gz = gzipSync(Buffer.from(src, 'utf8'), { level: 9 });
  const name = `gl-sdk4-ui-${view}.common.js.gz`;

  await writeFile(join(HERE, 'dist', name), gz);
  await writeFile(join(PATCH_VIEWS, name), gz);

  const stockGz = await readFile(
    join(HERE, 'orig', `${view}.js`), 'utf8'
  ).then((s) => gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).length);

  console.log(
    `${view.padEnd(17)} ${String(src.length).padStart(9)} B src -> ` +
      `${String(gz.length).padStart(7)} B gz  (stock packs to ${stockGz} B)`
  );
}
