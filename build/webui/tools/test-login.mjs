// Regression test for the login redirect loop.
//
// The first build shipped a beforeRouteEnter that called `resume` through
// window.$rpcRequest. That helper redirects to the login route on "Access
// denied", and beforeRouteEnter runs before the route becomes current, so the
// helper's own "don't redirect if we're already on login" guard did not fire.
// Each redirect re-entered the route, which called resume again. The login page
// reloaded forever and the device could not be administered.
//
// This drives the real bundle's beforeRouteEnter with a failing session and a
// failing resume, and asserts what must be true:
//
//   * next() is called exactly once
//   * resume is attempted at most once
//   * nothing pushes the router anywhere
//
// usage: node tools/test-login.mjs [src|orig|base]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = process.argv[2] || 'src';

let failures = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`  ${label.padEnd(48)} ${String(got).padEnd(6)} ${ok ? 'ok' : `EXPECTED ${want}`}`);
}

const source = await readFile(join(HERE, FROM, 'login.js'), 'utf8');

// Counters the stubs feed.
let resumeCalls = 0;
let rpcRequestCalls = [];
let routerPushes = [];

const noop = () => {};
const denied = { message: 'Access denied', code: -32000, type: 'api' };

// The one thing the fix depends on: a request that does not pass through the
// app's shared error handler. If the bundle reaches for $rpcRequest instead,
// rpcRequestCalls records it and the test fails.
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.method === 'resume') resumeCalls++;
  return { json: async () => ({ jsonrpc: '2.0', id: body.id, error: denied }) };
};

const windowStub = {
  $rpcRequest: (method) => {
    rpcRequestCalls.push(method);
    if (method === 'alive') return Promise.reject(denied);
    if (method === 'resume') resumeCalls++;
    return Promise.reject(denied);
  },
  $getCookie: () => '',
  $message: { success: noop, error: noop, warning: noop, closeAll: noop },
  $axios: Object.assign(() => Promise.resolve({}), { create: () => ({}) }),
  location: { href: '', origin: '', search: '', hash: '' },
  navigator: { userAgent: 'node' },
  addEventListener: noop,
  removeEventListener: noop
};
const element = () => ({
  style: {},
  dataset: {},
  sheet: { insertRule: noop, cssRules: [] },
  setAttribute: noop,
  getAttribute: () => null,
  appendChild: noop,
  removeChild: noop,
  insertBefore: noop,
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
  getElementsByTagName: () => [element()],
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop
};

windowStub.window = windowStub;
windowStub.document = documentStub;

const moduleObj = { exports: {} };
const component = new Function(
  'module', 'exports', 'window', 'document', 'navigator', 'self', 'fetch',
  `return (${source.trimEnd().replace(/;\s*$/, '')});`
)(moduleObj, moduleObj.exports, windowStub, documentStub, windowStub.navigator, windowStub, globalThis.fetch);

check('bundle evaluates to a component', typeof component, 'object');
check('it has a route guard', typeof component.beforeRouteEnter, 'function');

// Drive the guard the way vue-router does: `to`, `from`, `next`.
let nextCalls = 0;
let nextArgs = [];
const next = (arg) => {
  nextCalls++;
  nextArgs.push(arg);
  // vue-router runs a function argument once the component instance exists.
  if (typeof arg === 'function') {
    arg({
      $loadMenuRoute: () => Promise.reject(new Error('no menus in this test')),
      $router: { replace: (t) => routerPushes.push(t), push: (t) => routerPushes.push(t) },
      resuming: false
    });
  }
};

const to = { name: 'login', params: {}, query: {} };
const from = { name: undefined, params: {}, query: {} };

component.beforeRouteEnter.call({}, to, from, next);

// Let every promise in the chain settle.
await new Promise((r) => setTimeout(r, 60));

check('next() called exactly once', nextCalls, 1);
check('next() was not handed a redirect', nextArgs[0] === undefined || typeof nextArgs[0] === 'function', true);
check('resume attempted at most once', resumeCalls <= 1, true);
check('resume did not go through $rpcRequest', rpcRequestCalls.includes('resume'), false);
check('nothing pushed the router', routerPushes.length, 0);

// And run the guard a second time, as a redirect would: still no storm.
const before = resumeCalls;
component.beforeRouteEnter.call({}, to, from, next);
await new Promise((r) => setTimeout(r, 60));
check('a second entry does not re-attempt resume', resumeCalls - before, 0);

console.log('');
console.log(failures === 0 ? `login guard (${FROM}): all checks passed`
  : `login guard (${FROM}): ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
