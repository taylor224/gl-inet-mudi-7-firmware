// One English source, one file per locale.
//
// /www/i18n is read with a directory traversal that matches
// `<anything>.<locale>.json`, so a new namespace is added by dropping new
// files in rather than editing the vendor's. load_locales only reads files
// matching the locale being requested, and vue-i18n's fallbackLocale cannot
// help with a namespace that was never loaded -- so the same English text is
// written for every locale the firmware offers, and real translations can
// replace individual files later.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

export const LOCALES = ['de', 'en', 'es', 'it', 'ja', 'zh-cn', 'zh-tw'];

// Every namespace file in i18n/, keyed by its basename.
export async function loadNamespaces() {
  const dir = join(HERE, 'i18n');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  const out = {};
  for (const file of files) {
    out[basename(file, '.json')] = JSON.parse(await readFile(join(dir, file), 'utf8'));
  }
  return out;
}

// Merged object for one locale, in the shape load_locales returns per file.
export async function messagesFor(_locale) {
  const namespaces = await loadNamespaces();
  return Object.assign({}, ...Object.values(namespaces));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = join(HERE, '..', 'patch', 'www', 'i18n');
  await mkdir(target, { recursive: true });
  const namespaces = await loadNamespaces();

  for (const [name, body] of Object.entries(namespaces)) {
    for (const locale of LOCALES) {
      const file = `gl-sdk4-ui-${name}.${locale}.json`;
      await writeFile(join(target, file), JSON.stringify(body, null, 2) + '\n');
    }
    console.log(`${name.padEnd(14)} -> ${LOCALES.length} locale files`);
  }
}
