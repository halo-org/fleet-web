import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageUpload, blobUrl, maxImageBytes } from '../public/uploads.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function accepted(offset, status = 204) {
  return new Response(null, { status, headers: { 'upload-offset': String(offset) } });
}

function file(size = 7) {
  return new File([new Uint8Array(size)], 'image.png', { type: 'image/png' });
}

test('resumes from the committed offset after a lost chunk acknowledgement', async (context) => {
  const source = file(1024 * 1024 + 7);
  let stored = 0;
  let lost = false;
  const chunks = [];
  const creates = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/uploads') {
      creates.push(JSON.parse(options.body));
      return json({});
    }
    assert.ok(url.startsWith('/api/uploads/123'));
    if (options.method === 'HEAD') return accepted(stored, 200);
    if (options.method === 'PATCH') {
      assert.equal(Number(options.headers['upload-offset']), stored);
      chunks.push(options.body.size);
      stored += options.body.size;
      if (!lost) {
        lost = true;
        throw new TypeError('Acknowledgement lost');
      }
      return accepted(stored);
    }
    assert.equal(url, '/api/uploads/123/complete');
    assert.equal(stored, source.size);
    return json({ blob_id: '456' });
  });

  const image = await new ImageUpload(source, '123').run();

  assert.deepEqual(image, { type: 'image', blob_id: '456' });
  assert.deepEqual(chunks, [1024 * 1024, 7]);
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0], creates[1]);
});

test('retries ambiguous completion without uploading the bytes again', async (context) => {
  let stored = 0;
  let completions = 0;
  let chunks = 0;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/uploads') return json({});
    if (options.method === 'HEAD') return accepted(stored, 200);
    if (options.method === 'PATCH') {
      chunks++;
      stored += options.body.size;
      return accepted(stored);
    }
    completions++;
    if (completions === 1) throw new TypeError('Connection lost');
    return json({ blob_id: '1' });
  });

  assert.deepEqual(await new ImageUpload(file(), '1').run(), { type: 'image', blob_id: '1' });
  assert.equal(chunks, 1);
  assert.equal(completions, 2);
});

test('permanent validation failures are not automatically retried', async (context) => {
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return json({ error: { message: 'Invalid image' } }, 422);
  });

  await assert.rejects(new ImageUpload(file(), '1').run(), /Invalid image/);
  assert.equal(attempts, 1);
});

test('cancellation stops retries and can discard the pending upload', async (context) => {
  const controller = new AbortController();
  const methods = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    methods.push(options.method);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  });
  const upload = new ImageUpload(file(), '1');

  await assert.rejects(upload.run({ signal: controller.signal }), /Aborted/);
  await upload.cancel();
  assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('invalid sizes, image types, and external references are rejected', () => {
  assert.throws(() => new ImageUpload(file(0)), /between/);
  assert.throws(() => new ImageUpload({ size: maxImageBytes + 1, type: 'image/png' }), /between/);
  assert.throws(() => new ImageUpload({ size: 7, type: 'image/svg+xml' }), /PNG/);
  assert.throws(() => blobUrl('https://example.com/image.png'), /Invalid/);
  assert.equal(blobUrl('123'), '/api/blobs/123');
});
