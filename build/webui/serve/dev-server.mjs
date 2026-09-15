// Run the real admin panel against the real device, with our edited views
// swapped in. Nothing is written to the router.
//
// Everything is proxied to the device except /views/gl-sdk4-ui-<view>.common.js
// for the views we have de-minified, which are served from src/ instead. The
// session cookie, RPC calls and the /ws status stream all go to the device, so
// what renders is the live UI on live data.
//
// The /ws stream is not optional. Cards like the cellular one read from a Vuex
// statusMap fed only by that socket -- `moduleStatus('cellular.modems_info')`
// and friends -- so a proxy that drops the Upgrade handshake renders a fully
// working router as "No Modem device found" with a clean console and 200s on
// every RPC.
//
//   node serve/dev-server.mjs [--device 192.168.8.1] [--port 8088] [--from src]
//
// --from orig serves the untouched stock bundles instead of our de-minified
// ones, through the same proxy. Running one server on each is the A/B test for
// "is this our edit or is this the device?" -- everything but the view source
// is identical between the two.
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messagesFor } from '../tools/i18n.mjs';
import { handle as cellguardMock } from './cellguard-mock.mjs';
import { handle as rssiguardMock } from './rssiguard-mock.mjs';

// RPC objects the dev server can answer for when the device does not have them.
const MOCKS = { cellguard: cellguardMock, rssiguard: rssiguardMock };

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DEVICE = arg('device', '192.168.8.1');
const PORT = Number(arg('port', '8088'));
const FROM = arg('from', 'src');

if (!['src', 'orig', 'base'].includes(FROM)) {
  console.error(`--from must be src, base or orig (got ${FROM})`);
  process.exit(2);
}

const available = new Set(
  (await readdir(join(HERE, FROM)).catch(() => []))
    .filter((f) => f.endsWith('.js'))
    .map((f) => basename(f, '.js'))
);

const VIEW_RE = /^\/views\/gl-sdk4-ui-([a-z0-9-]+)\.common\.js$/;

// Only small POSTs are buffered for inspection. Firmware uploads go through
// this proxy too and must keep streaming.
const MAX_INSPECT_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_INSPECT_BYTES) {
        reject(new Error('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isLoadLocales(body) {
  try {
    const msg = JSON.parse(body.toString('utf8'));
    const p = msg?.params;
    return msg?.method === 'call' && Array.isArray(p) && p[1] === 'ui' && p[2] === 'load_locales';
  } catch {
    return false;
  }
}

// Forward a load_locales call, then append our own namespace bundle to the
// locales array. The app merges every entry in that array, so nothing has to
// be rewritten -- ours simply lands on top. On the device the same strings
// arrive as new files in /www/i18n, which load_locales picks up by directory
// traversal; this keeps the two paths in step during development.
async function proxyLoadLocales(req, res, body) {
  const headers = { ...req.headers, host: DEVICE };
  delete headers['accept-encoding'];
  headers['content-length'] = String(body.length);

  const upstream = httpRequest(
    { host: DEVICE, port: 80, path: req.url, method: req.method, headers },
    (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', async () => {
        let payload = Buffer.concat(chunks);
        try {
          const parsed = JSON.parse(payload.toString('utf8'));
          if (Array.isArray(parsed?.result?.locales)) {
            const locale = JSON.parse(body.toString('utf8')).params[3]?.locale ?? 'en';
            parsed.result.locales.push(await messagesFor(locale));
            payload = Buffer.from(JSON.stringify(parsed), 'utf8');
            console.log(`i18n   merged local namespaces into load_locales(${locale})`);
          }
        } catch (err) {
          console.error(`i18n   merge skipped: ${err.message}`);
        }
        const outHeaders = { ...up.headers };
        delete outHeaders['content-encoding'];
        outHeaders['content-length'] = String(payload.length);
        res.writeHead(up.statusCode, outHeaders);
        res.end(payload);
      });
    }
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`device unreachable: ${err.message}`);
  });

  upstream.end(body);
}

const server = createServer(async (req, res) => {
  // The client going away is normal, not an error worth crashing over.
  res.on('error', () => {});
  req.on('aborted', () => {});

  const url = new URL(req.url, 'http://localhost');
  const match = VIEW_RE.exec(url.pathname);

  if (match && available.has(match[1])) {
    const body = await readFile(join(HERE, FROM, `${match[1]}.js`), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Served-By': `dev-server (local ${FROM})`
    });
    res.end(body);
    console.log(`local[${FROM}]  ${url.pathname}`);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = null;
    try {
      body = await readBody(req);
    } catch {
      body = null; // oversized: fall through to the streaming proxy below
    }
    if (body && isLoadLocales(body)) {
      await proxyLoadLocales(req, res, body);
      return;
    }
    if (body) {
      await proxyRpc(req, res, body);
      return;
    }
  }

  // Accept-Encoding is forwarded untouched. /www ships only .js.gz files and
  // nginx serves them through gzip_static, which needs the client to ask for
  // gzip -- strip the header and every script 302s away instead of loading.
  // Proxied bodies are piped byte for byte, so the encoding passes straight
  // through to the browser.
  const headers = { ...req.headers, host: DEVICE };

  const upstream = httpRequest(
    { host: DEVICE, port: 80, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      // A browser that navigates away mid-response leaves this pipe writing
      // into a closed socket. Without a handler the EPIPE is fatal to the
      // whole process, which is a poor trade for a development proxy.
      up.on('error', () => res.destroy());
      up.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    console.error(`proxy ${url.pathname}: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`device unreachable: ${err.message}`);
  });

  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
});

// Ordinary RPC, with one safety net: a call to an object the device does not
// have comes back as -32601, and for `cellguard` that is answered locally
// instead. It lets the blacklist UI be exercised before the daemon is on the
// device, and stops mattering the moment it is.
async function proxyRpc(req, res, body) {
  const headers = { ...req.headers, host: DEVICE, 'content-length': String(body.length) };
  delete headers['accept-encoding'];

  const upstream = httpRequest(
    { host: DEVICE, port: 80, path: req.url, method: req.method, headers },
    (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        let payload = Buffer.concat(chunks);
        try {
          const request = JSON.parse(body.toString('utf8'));
          const answer = JSON.parse(payload.toString('utf8'));
          const [, object, method, params] = request.params || [];
          if (
            request.method === 'call' &&
            MOCKS[object] &&
            answer?.error?.code === -32601
          ) {
            const mocked = MOCKS[object](method, params);
            if (mocked !== null) {
              payload = Buffer.from(
                JSON.stringify({ jsonrpc: '2.0', id: request.id, result: mocked }),
                'utf8'
              );
              console.log(`mock   ${object}.${method}`);
            }
          }
        } catch {
          // Not JSON, or not a shape we touch. Pass it through untouched.
        }
        const outHeaders = { ...up.headers };
        delete outHeaders['content-encoding'];
        outHeaders['content-length'] = String(payload.length);
        res.writeHead(up.statusCode, outHeaders);
        res.end(payload);
      });
    }
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`device unreachable: ${err.message}`);
  });

  upstream.end(body);
}

// WebSocket passthrough for /ws. Node does not proxy upgrades on its own: the
// request has to be replayed to the device, the 101 written back by hand, and
// the two raw sockets joined.
server.on('upgrade', (req, clientSocket, head) => {
  const upstream = httpRequest({
    host: DEVICE,
    port: 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: DEVICE }
  });

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`;
    const headerLines = [];
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        headerLines.push(`${key}: ${one}`);
      }
    }
    clientSocket.write(`${statusLine}\r\n${headerLines.join('\r\n')}\r\n\r\n`);

    if (upstreamHead?.length) upstreamSocket.unshift(upstreamHead);
    if (head?.length) upstreamSocket.write(head);

    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);

    console.log(`ws     ${req.url.split('?')[0]} upgraded`);
  });

  // The device answered without upgrading -- 401 from oui-ws.lua when the sid
  // is missing or stale. Pass it on rather than leaving the browser hanging.
  upstream.on('response', (res) => {
    const headerLines = Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`);
    clientSocket.write(
      `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${headerLines.join('\r\n')}\r\n\r\n`
    );
    res.pipe(clientSocket);
    console.log(`ws     ${req.url.split('?')[0]} refused: ${res.statusCode}`);
  });

  upstream.on('error', (err) => {
    console.error(`ws     ${req.url}: ${err.message}`);
    clientSocket.destroy();
  });

  upstream.end();
});

server.on('clientError', (err, socket) => {
  if (!socket.destroyed) socket.destroy();
});

// The device disappearing mid-request -- Wi-Fi dropping, the router
// rebooting after a setting we just changed -- must not end the session. Log
// it and stay up; the next request reconnects.
process.on('uncaughtException', (err) => {
  console.error(`recovered: ${err.code || ''} ${err.message}`);
});
process.on('unhandledRejection', (err) => {
  console.error(`recovered: ${err && err.message ? err.message : err}`);
});

server.listen(PORT, () => {
  console.log(`dev server   http://localhost:${PORT}`);
  console.log(`device       http://${DEVICE}`);
  console.log(`serving      ${FROM}/`);
  console.log(`local views  ${[...available].sort().join(', ') || '(none)'}`);
  console.log('\nEverything else is proxied straight to the device.');
});
