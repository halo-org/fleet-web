import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGzip } from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
const upstream = new URL(process.env.FLEET_API_URL || 'http://127.0.0.1:1337');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const vendors = {
  '/vendor/marked.js': path.join(root, 'node_modules/marked/lib/marked.esm.js'),
  '/vendor/purify.js': path.join(root, 'node_modules/dompurify/dist/purify.es.mjs'),
};
const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

if (!['http:', 'https:'].includes(upstream.protocol))
  throw new Error('FLEET_API_URL must use HTTP or HTTPS');

function error(response, status, message) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { message } }));
}

function proxy(request, response) {
  const headers = {
    ...request.headers,
    host: upstream.host,
    'x-forwarded-host': request.headers.host,
  };
  for (const name of hopHeaders) delete headers[name];
  const transport = upstream.protocol === 'https:' ? https : http;
  const target = transport.request(
    upstream,
    {
      method: request.method,
      path: `${upstream.pathname.replace(/\/$/, '')}${request.url.slice(4) || '/'}`,
      headers,
    },
    (incoming) => {
      const headers = { ...incoming.headers, 'cache-control': 'no-store' };
      for (const name of hopHeaders) delete headers[name];
      response.writeHead(incoming.statusCode, headers);
      response.flushHeaders();
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    },
  );
  target.on('error', () =>
    error(response, 502, 'Fleet is unavailable. Check that the backend is running.'),
  );
  request.on('aborted', () => target.destroy());
  request.on('error', () => target.destroy());
  response.on('close', () => target.destroy());
  request.pipe(target);
}

async function serviceWorker() {
  const entries = await readdir(publicRoot, { recursive: true, withFileTypes: true });
  const assets = entries
    .filter((entry) => entry.isFile() && entry.name !== 'sw.js')
    .map(
      (entry) =>
        `/${path.relative(publicRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')}`,
    )
    .concat(Object.keys(vendors))
    .sort();
  const contents = await Promise.all(
    assets.map((asset) => readFile(vendors[asset] || path.join(publicRoot, asset))),
  );
  const script = await readFile(path.join(publicRoot, 'sw.js'), 'utf8');
  const hash = createHash('sha256').update(script);
  contents.forEach((content, index) => hash.update(assets[index]).update(content));
  const cacheName = `fleet-shell-${hash.digest('hex')}`;
  return `const cacheName = ${JSON.stringify(cacheName)};\nconst assets = ${JSON.stringify(assets)};\n${script}`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (
        request.headers.origin &&
        request.headers.origin !== `http://${request.headers.host}` &&
        request.headers.origin !== `https://${request.headers.host}`
      ) {
        return error(response, 403, 'Cross-origin requests are not allowed.');
      }
      return proxy(request, response);
    }
    if (!['GET', 'HEAD'].includes(request.method))
      return error(response, 405, 'Method not allowed.');
    if (url.pathname === '/sw.js') {
      const script = await serviceWorker();
      response.writeHead(200, {
        'content-type': types['.js'],
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(script),
        'x-content-type-options': 'nosniff',
      });
      return response.end(request.method === 'HEAD' ? undefined : script);
    }
    const callback =
      url.searchParams.has('state') &&
      (url.searchParams.has('code') || url.searchParams.has('error'));
    const filename = callback
      ? path.join(publicRoot, 'callback.html')
      : vendors[url.pathname] ||
        path.resolve(
          publicRoot,
          `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`,
        );
    if (!vendors[url.pathname] && !filename.startsWith(publicRoot + path.sep))
      return error(response, 404, 'Not found.');
    const info = await stat(filename);
    if (!info.isFile()) return error(response, 404, 'Not found.');
    const etag = `"${info.size}-${info.mtimeMs}"`;
    const headers = {
      'content-type': types[path.extname(filename)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      vary: 'Accept-Encoding',
      etag,
    };
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers);
      return response.end();
    }
    const gzip =
      path.extname(filename) !== '.png' &&
      /\bgzip\b/.test(request.headers['accept-encoding'] || '');
    if (gzip) headers['content-encoding'] = 'gzip';
    else headers['content-length'] = info.size;
    response.writeHead(200, headers);
    if (request.method === 'HEAD') return response.end();
    const stream = createReadStream(filename);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    if (gzip) {
      const compressor = createGzip();
      compressor.on('error', () => response.destroy());
      stream.pipe(compressor).pipe(response);
    } else stream.pipe(response);
  } catch (cause) {
    error(
      response,
      cause.code === 'ENOENT' ? 404 : 500,
      cause.code === 'ENOENT' ? 'Not found.' : 'Could not serve this request.',
    );
  }
});

server.listen(port, host, () =>
  console.log(`Fleet Web: http://${host}:${port}\nFleet API: ${upstream.origin}`),
);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
