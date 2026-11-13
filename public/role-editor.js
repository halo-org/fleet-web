import { request, prepareWrite, write } from './api.js';

const fieldKeys = ['name', 'version', 'title', 'description', 'hidden', 'system_prompt'];

export function roleFields(role = { model: { name: '' } }) {
  const {
    name = '',
    version,
    title = '',
    description = '',
    hidden = false,
    system_prompt = '',
    ...settings
  } = role;
  return {
    name,
    title,
    description,
    hidden,
    system_prompt,
    settings: JSON.stringify(settings, null, 2),
  };
}

export function roleDefinition(fields) {
  let settings;
  try {
    settings = JSON.parse(fields.settings);
  } catch (error) {
    throw new Error(`Settings are not valid JSON. ${error.message}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('Settings must be a JSON object.');
  const field = fieldKeys.find((key) => key in settings);
  if (field) throw new Error(`Remove “${field}” from settings.`);
  const title = fields.title.trim();
  const description = fields.description.trim();
  return {
    ...(title && { title }),
    ...(description && { description }),
    ...(fields.hidden && { hidden: true }),
    ...settings,
    system_prompt: fields.system_prompt,
  };
}

export class RoleEdit {
  operation = null;
  conflict = false;
  saving = false;

  constructor(role, draft) {
    this.name = role?.name;
    this.version = draft ? draft.version : role?.version;
    this.initial = roleFields(role);
    this.fields = draft ? { ...this.initial, ...draft.fields } : { ...this.initial };
  }

  get key() {
    return this.name || '';
  }

  get changed() {
    return JSON.stringify(this.fields) !== JSON.stringify(this.initial);
  }

  get draft() {
    return { fields: this.fields, version: this.version };
  }

  async save() {
    if (this.conflict) throw new Error('Load the current role before saving again.');
    const name = this.name || this.fields.name.trim();
    if (!this.operation) {
      if (!name) throw new Error('Enter a role name.');
      if (!/^[\w-]+$/.test(name))
        throw new Error('Role names may contain only ASCII letters, digits, - and _.');
      this.operation = prepareWrite(
        `/roles/${encodeURIComponent(name)}`,
        roleDefinition(this.fields),
        this.name ? { method: 'PUT', version: this.version } : { method: 'PUT', create: true },
      );
    }
    try {
      await write(this.operation);
      this.operation = null;
      return name;
    } catch (error) {
      if (error.status && error.status < 500) {
        this.operation = null;
        this.conflict = error.status === 412 && !!this.name;
      }
      // On an uncertain result, keep the exact key, payload and precondition.
      throw error;
    }
  }

  async refresh() {
    const response = await request(`/roles/${encodeURIComponent(this.name)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    this.version = response.data.version;
    this.conflict = false;
    // Keep the draft; refreshing a conflict is not permission to overwrite it.
    return response;
  }
}
