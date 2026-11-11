import { ApiError, newId, request, requireSignIn } from './api.js';

export const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const maxImageBytes = 10 * 1024 * 1024;
const chunkBytes = 1024 * 1024;

export function blobUrl(id) {
  if (!/^\d{1,39}$/.test(id)) throw new Error('Invalid image reference.');
  return `/api/blobs/${id}`;
}

async function checkedFetch(path, options) {
  const response = await fetch(`/api${path}`, options);
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    requireSignIn(problem);
    throw new ApiError(
      problem?.error?.message || `Upload failed (${response.status}).`,
      response.status,
    );
  }
  return response;
}

function offset(response, size) {
  const value = response.headers.get('upload-offset');
  const number = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > size)
    throw new Error('The server returned an invalid upload offset.');
  return number;
}

/** Retain the instance when retrying: its ID identifies the same resumable upload. */
export class ImageUpload {
  constructor(file, id = newId()) {
    if (!imageTypes.includes(file.type)) throw new Error('Attach a PNG, JPEG, GIF, or WebP image.');
    if (!file.size || file.size > maxImageBytes)
      throw new Error('Images must be between 1 byte and 10 MiB.');
    this.file = file;
    this.id = id;
  }

  async run({ signal, onProgress = () => {} } = {}) {
    const path = `/uploads/${this.id}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const transferSignal = () =>
          signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000);
        await request('/uploads', {
          method: 'POST',
          signal: transferSignal(),
          body: { id: this.id, media_type: this.file.type, size: this.file.size },
        });
        let accepted = offset(
          await checkedFetch(path, { method: 'HEAD', signal: transferSignal() }),
          this.file.size,
        );
        onProgress(accepted / this.file.size);
        while (accepted < this.file.size) {
          const end = Math.min(accepted + chunkBytes, this.file.size);
          const response = await checkedFetch(path, {
            method: 'PATCH',
            signal: transferSignal(),
            headers: {
              'content-type': 'application/offset+octet-stream',
              'upload-offset': String(accepted),
            },
            body: this.file.slice(accepted, end),
          });
          if (offset(response, this.file.size) !== end)
            throw new Error('The server did not accept the complete chunk.');
          accepted = end;
          onProgress(accepted / this.file.size);
        }
        const { data } = await request(`${path}/complete`, {
          method: 'POST',
          body: {},
          signal: transferSignal(),
        });
        blobUrl(data.blob_id);
        return { type: 'image', blob_id: data.blob_id };
      } catch (error) {
        if (
          signal?.aborted ||
          attempt === 2 ||
          (error instanceof ApiError && error.status < 500 && error.status !== 409)
        )
          throw error;
        // HEAD on the next attempt resolves ambiguous PATCH acknowledgements.
      }
    }
  }

  async cancel() {
    await request(`/uploads/${this.id}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
  }
}
