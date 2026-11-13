import { ApiError, prepareWrite, request, write } from './api.js';

const types = { md: 'text/markdown', markdown: 'text/markdown', json: 'application/json' };

export function roleFile(filename) {
  const match = /^([\w-]+)\.(md|markdown|json)$/i.exec(filename);
  return match && { name: match[1], type: types[match[2].toLowerCase()] };
}

export async function readRoleFile(file) {
  const role = roleFile(file.name);
  if (!role)
    return {
      file: file.name,
      status: 'failed',
      message: 'Use a .md or .json file named with letters, digits, - and _.',
    };
  try {
    return { file: file.name, ...role, source: await file.text(), status: 'ready' };
  } catch {
    return { file: file.name, status: 'failed', message: 'Could not read this file.' };
  }
}

export async function importRole(item, replace = false) {
  const path = `/roles/${encodeURIComponent(item.name)}`;
  if (item.replace !== replace) item.operation = undefined;
  item.replace = replace;
  item.status = 'pending';
  item.message = '';
  item.retry = false;
  try {
    if (!item.operation) {
      const version = replace ? (await request(path)).data.version : undefined;
      item.operation = prepareWrite(path, item.source, {
        method: 'PUT',
        type: item.type,
        version,
        create: !replace,
      });
    }
    await write(item.operation);
    item.status = replace ? 'replaced' : 'imported';
  } catch (error) {
    const rejected = error instanceof ApiError && error.status < 500;
    if (rejected) item.operation = undefined;
    if (rejected && error.status === 412) {
      item.status = 'exists';
    } else {
      item.status = 'failed';
      item.message = error instanceof ApiError ? error.message : 'Could not reach Fleet.';
      item.retry = !rejected;
    }
  }
}
