// Expand a minified view bundle into readable source.
//
// The app loads a view with `eval(fileContents)`, so formatting is free: a
// pretty-printed bundle behaves exactly like the packed one.
//
// Two files come out of this, and the difference matters:
//
//   base/<view>.js   pristine beautified stock code. Never edit it. It is the
//                    reference `verify` diffs against, so our changes stay
//                    visible as a short reviewable patch instead of being lost
//                    in 30,000 reformatted lines.
//   src/<view>.js    the working copy. Edit this one. Only created if missing,
//                    so re-running beautify never clobbers work in progress.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PRETTIER_OPTIONS = {
  parser: 'babel',
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'none',
  semi: true
};

export async function beautify(source) {
  return prettier.format(source, PRETTIER_OPTIONS);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const views = process.argv.slice(2);
  if (views.length === 0) {
    console.error('usage: beautify.mjs <view> [view ...]');
    process.exit(2);
  }

  await mkdir(join(HERE, 'src'), { recursive: true });
  await mkdir(join(HERE, 'base'), { recursive: true });

  for (const view of views) {
    const source = await readFile(join(HERE, 'orig', `${view}.js`), 'utf8');
    const formatted = await beautify(source);

    await writeFile(join(HERE, 'base', `${view}.js`), formatted);

    const srcPath = join(HERE, 'src', `${view}.js`);
    let note = 'src kept';
    if (!existsSync(srcPath)) {
      await writeFile(srcPath, formatted);
      note = 'src created';
    }

    console.log(
      `${view.padEnd(18)} ${String(source.length).padStart(8)} B -> ` +
        `${String(formatted.split('\n').length).padStart(6)} lines  (${note})`
    );
  }
}
