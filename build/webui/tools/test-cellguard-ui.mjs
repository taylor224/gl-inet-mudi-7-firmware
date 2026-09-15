// Regression test: a refused RPC must not be reported as success.
//
// The cellguard module answers { code: -1, msg: "..." } when it cannot do what
// was asked -- "no serving cell is known yet", for instance. That is a normal
// JSON-RPC *result*, so the request promise resolves and the call lands in the
// success branch. The first build took that as proof the operation worked and
// showed "Applied!" while nothing had changed.
//
// usage: node tools/test-cellguard-ui.mjs [src|orig|base]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = process.argv[2] || 'src';

let failures = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`  ${label.padEnd(52)} ${String(got).padEnd(8)} ${ok ? 'ok' : `EXPECTED ${want}`}`);
}

const noop = () => {};
const element = () => ({
  style: {}, dataset: {}, sheet: { insertRule: noop, cssRules: [] },
  setAttribute: noop, getAttribute: () => null, appendChild: noop, removeChild: noop,
  insertBefore: noop, addEventListener: noop, removeEventListener: noop,
  classList: { add: noop, remove: noop, contains: () => false }
});
const documentStub = {
  cookie: '', title: '', currentScript: { src: 'http://127.0.0.1/js/app.js' },
  head: element(), body: element(), documentElement: element(),
  createElement: element, createTextNode: () => ({}), getElementById: () => null,
  getElementsByTagName: () => [element()], querySelector: () => null,
  querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop
};
const windowStub = {
  $rpcRequest: () => Promise.resolve({}),
  $message: { success: noop, error: noop, warning: noop, closeAll: noop },
  $getCookie: () => '', $i: {},
  $axios: Object.assign(() => Promise.resolve({}), { create: () => ({ get: () => Promise.resolve({}), post: () => Promise.resolve({}), defaults: { headers: { common: {} } }, interceptors: { request: { use: noop }, response: { use: noop } } }) }),
  location: { href: '', origin: '', search: '', hash: '' },
  navigator: { userAgent: 'node' }, addEventListener: noop, removeEventListener: noop,
  matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop }),
  getComputedStyle: () => ({ getPropertyValue: () => '' })
};
windowStub.window = windowStub;
windowStub.document = documentStub;

const source = await readFile(join(HERE, FROM, 'cellular-detail.js'), 'utf8');
const moduleObj = { exports: {} };
const view = new Function(
  'module', 'exports', 'window', 'document', 'navigator', 'self',
  `return (${source.trimEnd().replace(/;\s*$/, '')});`
)(moduleObj, moduleObj.exports, windowStub, documentStub, windowStub.navigator, windowStub);

// The lock-tower component is nested a couple of levels down inside the page,
// so find it by the method under test rather than by a fixed path -- the test
// then survives the component tree being rearranged.
function findMethods(node, want, seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || seen.has(node) || depth > 6) return null;
  seen.add(node);
  const methods = node.options?.methods || node.methods;
  if (methods && typeof methods[want] === 'function') return methods;
  for (const child of Object.values(node.components || {})) {
    const found = findMethods(child, want, seen, depth + 1);
    if (found) return found;
  }
  return null;
}

const methods = findMethods(view, 'afterBlockChange');
check('a component exposing afterBlockChange exists', methods ? 'found' : 'missing', 'found');
check('it exposes afterBlockChange', typeof methods?.afterBlockChange, 'function');

if (typeof methods?.afterBlockChange !== 'function') {
  console.log('\ncellguard ui: cannot run, component shape changed');
  process.exit(1);
}

// Drive it with each kind of answer and record which toast it chose.
function run(payload) {
  const seen = { success: 0, error: 0, errorText: null, reloaded: 0 };
  const ctx = {
    blockBusy: true,
    $message: {
      closeAll: noop,
      success: () => seen.success++,
      error: (t) => { seen.error++; seen.errorText = t; }
    },
    $t: (k) => k,
    loadBlockedTowers: () => seen.reloaded++
  };
  const returned = methods.afterBlockChange.call(ctx, payload);
  return { ...seen, returned, busy: ctx.blockBusy };
}

const refused = run({ code: -1, msg: 'no serving cell is known yet' });
check('a refusal shows an error, not a success', refused.success, 0);
check('a refusal surfaces the reason', refused.errorText, 'no serving cell is known yet');
check('a refusal reports failure to the caller', refused.returned, false);
check('a refusal still clears the busy flag', refused.busy, false);

const ok = run({ code: 0, id: 'cfg1' });
check('a success shows the success toast', ok.success, 1);
check('a success shows no error', ok.error, 0);
check('a success reloads the list', ok.reloaded, 1);
check('a success reports success to the caller', ok.returned, true);

// Some methods answer with a bare payload and no code at all.
const bare = run({ blocks: [] });
check('a payload without a code counts as success', bare.success, 1);

console.log('');
console.log(failures === 0 ? `cellguard ui (${FROM}): all checks passed`
  : `cellguard ui (${FROM}): ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
