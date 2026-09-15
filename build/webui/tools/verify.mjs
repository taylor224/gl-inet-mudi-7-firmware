// Prove a de-minified view bundle is still something the router will accept.
//
// Four checks, cheapest first:
//
//   parse     src/<view>.js is valid JavaScript
//   faithful  base/<view>.js is exactly what prettier makes of orig/<view>.js,
//             so the reference we diff against really is the stock code
//   diff      src/<view>.js against base/<view>.js -- 0 lines for an untouched
//             view, otherwise the size of our patch, printed so it can be read
//   shape     the bundle, evaluated the way the app evaluates it, yields a Vue
//             component object instead of throwing
//
// AST equality is deliberately not used. Prettier drops redundant parentheses,
// which regroups associative operators (`a && (b && c)` -> `(a && b) && c`) and
// changes the tree without changing behaviour, so an AST diff reports noise.
//
// usage: verify.mjs [view ...]
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { beautify } from './beautify.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

function parse(source) {
  return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
}

function lineDiff(a, b) {
  const from = a.split('\n');
  const to = b.split('\n');
  const fromSet = new Map();
  for (const line of from) fromSet.set(line, (fromSet.get(line) || 0) + 1);
  let added = 0;
  for (const line of to) {
    const n = fromSet.get(line) || 0;
    if (n > 0) fromSet.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of fromSet.values()) removed += n;
  return { added, removed };
}

// Stand-ins for what the host app has in scope when it runs
// `eval(bundleSource)` from inside its own webpack module.
function makeSandbox() {
  const noop = () => {};
  const element = () => ({
    style: {},
    dataset: {},
    setAttribute: noop,
    getAttribute: () => null,
    appendChild: noop,
    removeChild: noop,
    addEventListener: noop,
    removeEventListener: noop,
    classList: { add: noop, remove: noop, contains: () => false }
  });

  const documentStub = {
    cookie: '',
    title: '',
    currentScript: { src: 'http://127.0.0.1/js/app.js' },
    head: element(),
    body: element(),
    documentElement: element(),
    createElement: element,
    createTextNode: () => ({}),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop
  };

  const windowStub = {
    $rpcRequest: () => Promise.resolve({}),
    $request: () => Promise.resolve({}),
    $message: { success: noop, error: noop, warning: noop, info: noop },
    $getCookie: () => '',
    $i: {},
    $axios: Object.assign(() => Promise.resolve({}), {
      create: () =>
        Object.assign(() => Promise.resolve({ data: {} }), {
          get: () => Promise.resolve({ data: {} }),
          post: () => Promise.resolve({ data: {} }),
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: noop }, response: { use: noop } }
        })
    }),
    $cancelMap: new Map(),
    $rpcReqCancelMap: new Map(),
    $commitHistory: noop,
    $getHistory: () => ({}),
    document: documentStub,
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '', hash: '' },
    navigator: { userAgent: 'node', language: 'en' },
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;

  const VueStub = function () {};
  VueStub.component = (name) => ({ name, render: () => null });
  VueStub.extend = (o) => o;
  VueStub.use = noop;
  VueStub.mixin = noop;
  VueStub.directive = noop;
  VueStub.nextTick = (fn) => Promise.resolve().then(fn);

  return { windowStub, documentStub, VueStub };
}

function evaluateBundle(source) {
  const { windowStub, documentStub, VueStub } = makeSandbox();
  const moduleObj = { exports: {} };
  const expression = source.trimEnd().replace(/;\s*$/, '');

  const fn = new Function(
    'module',
    'exports',
    'window',
    'document',
    'navigator',
    'self',
    'Vue',
    `return (${expression});`
  );

  return fn(
    moduleObj,
    moduleObj.exports,
    windowStub,
    documentStub,
    windowStub.navigator,
    windowStub,
    VueStub
  );
}

const requested = process.argv.slice(2);
const views =
  requested.length > 0
    ? requested
    : (await readdir(join(HERE, 'src')))
        .filter((f) => f.endsWith('.js'))
        .map((f) => basename(f, '.js'))
        .sort();

let failures = 0;

for (const view of views) {
  const notes = [];
  let src;

  try {
    src = await readFile(join(HERE, 'src', `${view}.js`), 'utf8');
  } catch {
    console.log(`${view.padEnd(17)} FAIL   src/${view}.js missing`);
    failures++;
    continue;
  }

  try {
    parse(src);
    notes.push('parse ok');
  } catch (err) {
    console.log(`${view.padEnd(17)} FAIL   parse error at offset ${err.pos}: ${err.message}`);
    failures++;
    continue;
  }

  let base;
  try {
    base = await readFile(join(HERE, 'base', `${view}.js`), 'utf8');
    const orig = await readFile(join(HERE, 'orig', `${view}.js`), 'utf8');
    if ((await beautify(orig)) === base) {
      notes.push('base faithful');
    } else {
      notes.push('BASE DOES NOT MATCH STOCK');
      failures++;
    }
  } catch (err) {
    notes.push(`base check failed: ${err.message}`);
    failures++;
  }

  if (base !== undefined) {
    const { added, removed } = lineDiff(base, src);
    notes.push(added || removed ? `diff +${added}/-${removed}` : 'diff none');
  }

  try {
    const component = evaluateBundle(src);
    if (component && (typeof component === 'object' || typeof component === 'function')) {
      const parts = ['name', 'render', 'data', 'methods', 'computed', 'components', 'props'].filter(
        (k) => k in component
      );
      notes.push(`shape ok [${component.name || '?'}: ${parts.join(' ') || Object.keys(component).slice(0, 4).join(' ')}]`);
    } else {
      notes.push(`SHAPE BAD (${typeof component})`);
      failures++;
    }
  } catch (err) {
    notes.push(`SHAPE THREW: ${String(err.message).split('\n')[0]}`);
    failures++;
  }

  console.log(`${view.padEnd(17)} ${notes.join('  |  ')}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
