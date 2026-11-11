import { ImageUpload, blobUrl } from './uploads.js';
import { node, icon } from './render.js';

/** Draft-local images. Only durable references are persisted; never binary payloads. */
export class Attachments {
  drafts = new Map();
  queue = [];
  active = 0;
  tiles = new WeakMap();

  constructor(container, key, changed, notify) {
    this.container = container;
    this.key = key;
    this.changed = changed;
    this.notify = notify;
    try {
      for (const [key, images] of Object.entries(
        JSON.parse(localStorage.getItem('fleet.images')) || {},
      )) {
        if (!Array.isArray(images)) continue;
        this.drafts.set(
          key,
          images
            .filter((image) => {
              try {
                return image.type === 'image' && !!blobUrl(image.blob_id);
              } catch {
                return false;
              }
            })
            .map((image) => ({ ...image, status: 'ready' })),
        );
      }
    } catch {
      /* Storage may be unavailable. */
    }
  }

  entries(key = this.key()) {
    return this.drafts.get(key) || [];
  }
  content(key = this.key()) {
    return this.entries(key)
      .filter((image) => image.status === 'ready')
      .map(({ blob_id }) => ({ type: 'image', blob_id }));
  }
  pending() {
    return this.entries().some((image) => image.status !== 'ready');
  }

  add(files) {
    const key = this.key();
    const images = this.entries(key);
    for (const file of files) {
      if (images.length >= 20) {
        this.notify('You can attach up to 20 images.');
        break;
      }
      try {
        if (
          images.reduce((total, image) => total + (image.size || 0), file.size) >
          40 * 1024 * 1024
        )
          throw new Error('Images can total up to 40 MiB per message.');
        const upload = new ImageUpload(file);
        const image = {
          name: file.name,
          size: file.size,
          upload,
          preview: URL.createObjectURL(file),
          status: 'queued',
          progress: 0,
        };
        images.push(image);
        this.queue.push({ key, image });
      } catch (error) {
        this.notify(error.message);
      }
    }
    this.drafts.set(key, images);
    this.update();
    this.pump();
  }

  pump() {
    while (this.active < 2 && this.queue.length) {
      const { key, image } = this.queue.shift();
      if (!this.entries(key).includes(image) || image.status !== 'queued') continue;
      this.active++;
      image.status = 'uploading';
      image.controller = new AbortController();
      this.update();
      void image.upload
        .run({
          signal: image.controller.signal,
          onProgress: (progress) => {
            image.progress = progress;
            this.update();
          },
        })
        .then((content) => {
          if (!this.entries(key).includes(image)) return;
          Object.assign(image, content, { status: 'ready' });
          if (image.preview) URL.revokeObjectURL(image.preview);
          delete image.preview;
        })
        .catch((error) => {
          if (!this.entries(key).includes(image)) return;
          image.status = 'failed';
          image.error = error.message;
        })
        .finally(() => {
          this.active--;
          this.update();
          this.pump();
        });
    }
  }

  restore(key, content) {
    for (const image of this.entries(key)) {
      image.controller?.abort();
      if (image.preview) URL.revokeObjectURL(image.preview);
      if (image.upload) void image.upload.cancel().catch(() => {});
    }
    this.drafts.set(
      key,
      content.map((image) => ({ ...image, name: 'Attached image', status: 'ready' })),
    );
    this.update();
  }

  clear(key, content) {
    const ids = new Set(content.map((image) => image.blob_id));
    this.drafts.set(
      key,
      this.entries(key).filter((image) => !ids.has(image.blob_id)),
    );
    this.update();
  }

  remove(key, image) {
    image.controller?.abort();
    if (image.preview) URL.revokeObjectURL(image.preview);
    this.drafts.set(
      key,
      this.entries(key).filter((item) => item !== image),
    );
    if (image.upload) void image.upload.cancel().catch(() => {});
    this.update();
  }

  update() {
    try {
      const saved = Object.fromEntries(
        [...this.drafts]
          .map(([key, images]) => [
            key,
            images
              .filter((image) => image.status === 'ready')
              .map(({ type, blob_id, name, size }) => ({ type, blob_id, name, size })),
          ])
          .filter(([, images]) => images.length),
      );
      localStorage.setItem('fleet.images', JSON.stringify(saved));
    } catch {
      /* Storage may be unavailable. */
    }
    this.render();
    this.changed();
  }

  render() {
    const key = this.key();
    const images = this.entries(key);
    let position = this.container.firstElementChild;
    for (const image of images) {
      let tile = this.tiles.get(image);
      if (!tile) {
        tile = node('div', 'attachment-tile');
        tile.preview = node('img');
        tile.preview.alt = image.name || 'Attached image';
        tile.status = node('span', 'attachment-status');
        tile.retry = node('button', '', 'Retry');
        tile.retry.type = 'button';
        tile.retry.onclick = () => {
          image.status = 'queued';
          this.queue.push({ key, image });
          this.update();
          this.pump();
        };
        const remove = node('button', 'icon-button');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${image.name || 'image'}`);
        remove.append(icon('close'));
        remove.onclick = () => this.remove(key, image);
        tile.append(tile.preview, tile.status, tile.retry, remove);
        this.tiles.set(image, tile);
      }
      const source = image.blob_id ? blobUrl(image.blob_id) : image.preview;
      if (tile.preview.getAttribute('src') !== source) tile.preview.src = source;
      const status =
        image.status === 'ready'
          ? image.name || 'Attached image'
          : image.status === 'failed'
            ? image.error
            : `Uploading ${Math.round(image.progress * 100)}%`;
      if (tile.status.textContent !== status) tile.status.textContent = status;
      tile.retry.hidden = image.status !== 'failed';
      if (tile !== position) this.container.insertBefore(tile, position);
      position = tile.nextElementSibling;
    }
    while (position) {
      const next = position.nextElementSibling;
      position.remove();
      position = next;
    }
    this.container.hidden = images.length === 0;
  }
}
