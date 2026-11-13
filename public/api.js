export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function requireSignIn(problem) {
  if (problem?.error?.code === 'sign_in_required') globalThis.location?.replace('/login.html');
}

export function newId() {
  return BigInt(`0x${crypto.randomUUID().replaceAll('-', '')}`).toString();
}

export async function request(path, { method = 'GET', body, key, version, create, signal } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  if (version) headers['if-match'] = `"${version}"`;
  if (create) headers['if-none-match'] = '*';
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    requireSignIn(problem);
    throw new ApiError(
      problem?.error?.message || `Request failed (${response.status}).`,
      response.status,
    );
  }
  const text = await response.text();
  return {
    data: text ? JSON.parse(text) : null,
    revision: response.headers.get('read-revision'),
  };
}

export function prepareWrite(path, body, { method = 'POST', version, create } = {}) {
  return { path, method, body, version, create, key: crypto.randomUUID() };
}

export async function write(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(operation.path, { ...operation, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      if (attempt === 2 || (error instanceof ApiError && error.status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
}

export class SSEParser {
  buffer = '';
  data = [];
  type = 'message';
  id = undefined;

  constructor(onEvent) {
    this.onEvent = onEvent;
  }

  push(chunk, final = false) {
    this.buffer += chunk;
    while (true) {
      const match = /[\r\n]/.exec(this.buffer);
      if (!match || (!final && match[0] === '\r' && match.index === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, match.index);
      const length = this.buffer.slice(match.index, match.index + 2) === '\r\n' ? 2 : 1;
      this.buffer = this.buffer.slice(match.index + length);
      this.line(line);
    }
  }

  line(line) {
    if (!line) {
      if (this.data.length)
        this.onEvent({ type: this.type, data: this.data.join('\n'), id: this.id });
      this.data = [];
      this.type = 'message';
      this.id = undefined;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    if (field === 'event') this.type = value || 'message';
    if (field === 'id' && !value.includes('\0')) this.id = value;
  }
}

export async function subscribe(
  path,
  { after, signal, onEvent, onStatus = () => {}, onReset = () => {} },
) {
  let delay = 500;
  while (!signal.aborted) {
    const connection = new AbortController();
    const connectionSignal = AbortSignal.any([signal, connection.signal]);
    let timeout;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => connection.abort(), 45_000);
    };
    globalThis.document?.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') connection.abort();
      },
      { signal: connection.signal },
    );
    globalThis.addEventListener?.('online', () => connection.abort(), {
      signal: connection.signal,
    });
    try {
      resetTimeout();
      onStatus('connecting');
      const headers = { accept: 'text/event-stream' };
      if (after !== undefined) headers['last-event-id'] = after;
      const response = await fetch(`/api${path}`, { headers, signal: connectionSignal });
      if (response.status === 401) {
        requireSignIn(await response.json().catch(() => null));
        return;
      }
      if ([400, 404, 410].includes(response.status)) {
        await response.body?.cancel();
        onReset();
        return;
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new Error('Subscription unavailable');
      }
      delay = 500;
      onStatus('live');
      const parser = new SSEParser((event) => {
        onEvent(event);
        if (event.id !== undefined) after = event.id;
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          resetTimeout();
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode(), true);
      } finally {
        connection.abort();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (signal.aborted) return;
      onStatus('offline');
    } finally {
      clearTimeout(timeout);
      connection.abort();
    }
    if (signal.aborted) return;
    onStatus('offline');
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      signal.addEventListener('abort', done, { once: true });
    });
    delay = Math.min(delay * 2, 15_000);
  }
}
