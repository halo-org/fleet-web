import { request } from './api.js';
import { node, icon } from './render.js';

export class RolePicker {
  constructor(element, preferred, onChange) {
    this.element = element;
    this.preferred = preferred;
    this.onChange = onChange;
    this.roles = [];
    this.titles = new Map();
    this.forms = new Map();
    this.name = '';
  }

  get title() {
    return this.roles.find((role) => role.name === this.name)?.title || this.name;
  }

  roleTitle(name) {
    return this.titles.get(name) || name;
  }

  async load() {
    this.element.replaceChildren(node('p', 'role-notice', 'Loading roles…'));
    try {
      const { data } = await request('/roles');
      this.titles = new Map(data.map((role) => [role.name, role.title]));
      this.roles = data.filter((role) => !role.hidden && !role.error);
      this.name =
        this.roles.find((role) => role.name === this.preferred)?.name || this.roles[0]?.name || '';
      this.render();
    } catch {
      const retry = node('button', 'text-button', 'Retry');
      retry.type = 'button';
      retry.onclick = () => this.load();
      this.element.replaceChildren(node('p', 'role-notice', 'Could not load roles.'), retry);
    }
    this.onChange();
  }

  render(initial = {}) {
    if (!this.roles.length) {
      this.element.replaceChildren(node('p', 'role-notice', 'No roles available.'));
      return;
    }
    this.roleButton = node('button', 'role-selection');
    this.roleButton.type = 'button';
    this.roleButton.setAttribute('aria-haspopup', 'dialog');
    this.roleButton.onclick = () => this.openRoles();
    this.parametersElement = node('div', 'role-parameters');
    this.element.replaceChildren(this.roleButton, this.parametersElement);
    this.showSelection(initial);
  }

  openRoles() {
    const dialog = node('dialog', 'role-dialog');
    dialog.setAttribute('aria-labelledby', 'role-dialog-title');
    const header = node('div', 'role-dialog-header');
    const title = node('h2', '', 'Choose a role');
    title.id = 'role-dialog-title';
    const close = node('button', 'icon-button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close role selector');
    close.append(icon('close'));
    close.onclick = () => dialog.close();
    header.append(title, close);
    const searchLabel = node('label', 'role-search');
    const search = node('input');
    search.type = 'search';
    search.placeholder = 'Search roles…';
    search.setAttribute('aria-label', 'Search roles');
    search.autocomplete = 'off';
    search.spellcheck = false;
    searchLabel.append(icon('search'), search);
    const results = node('div', 'role-results');
    results.setAttribute('role', 'listbox');
    results.setAttribute('aria-label', 'Roles');
    const empty = node('p', 'role-notice', 'No matching roles');
    empty.setAttribute('role', 'status');
    const roles = this.roles
      .toSorted((a, b) => (a.title || a.name).localeCompare(b.title || b.name))
      .map((role) => ({
        role,
        text: [role.name, role.title, role.description].join(' ').toLowerCase(),
      }));

    const filter = () => {
      const terms = search.value.trim().toLowerCase().split(/\s+/);
      const matching = roles.filter(({ text }) => terms.every((term) => text.includes(term)));
      results.replaceChildren(
        ...matching.map(({ role }) => {
          const button = node('button', 'role-option');
          button.type = 'button';
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', String(role.name === this.name));
          button.tabIndex = -1;
          button.append(roleText(role), icon('check'));
          button.onfocus = () => {
            for (const option of results.children) option.tabIndex = option === button ? 0 : -1;
          };
          button.onclick = () => {
            this.name = role.name;
            this.showSelection();
            this.onChange();
            dialog.close();
          };
          return button;
        }),
      );
      const current = results.querySelector('[aria-selected="true"]') || results.firstElementChild;
      if (current) current.tabIndex = 0;
      empty.hidden = matching.length !== 0;
      results.scrollTop = 0;
    };
    search.oninput = filter;
    dialog.onkeydown = (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dialog.close();
        return;
      }
      const options = [...results.children];
      const index = options.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = Math.min(index + 1, options.length - 1);
      else if (event.key === 'ArrowUp')
        next = index < 0 ? options.length - 1 : Math.max(index - 1, 0);
      else if (index >= 0 && event.key === 'Home') next = 0;
      else if (index >= 0 && event.key === 'End') next = options.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        options[next]?.focus({ preventScroll: true });
        options[next]?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && document.activeElement === search) {
        event.preventDefault();
        results.querySelector('[tabindex="0"]')?.click();
      } else if (
        index >= 0 &&
        event.key.length === 1 &&
        event.key !== ' ' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        search.focus();
        search.value += event.key;
        filter();
      }
    };
    dialog.onclick = (event) => {
      if (event.target === dialog) dialog.close();
    };
    dialog.onclose = () => {
      dialog.remove();
      this.roleButton.focus({ preventScroll: true });
    };
    dialog.append(header, searchLabel, empty, results);
    this.element.append(dialog);
    filter();
    dialog.showModal();
    if (matchMedia('(pointer: fine)').matches) search.focus();
    results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  showSelection(initial = {}) {
    const role = this.roles.find((role) => role.name === this.name);
    this.roleButton.replaceChildren(roleText(role), icon('chevron'));
    this.roleButton.setAttribute('aria-label', `Change role: ${role.title || role.name}`);
    if (!this.forms.has(this.name)) {
      const definitions = {
        ...Object.fromEntries(Object.keys(initial).map((name) => [name, {}])),
        ...role?.parameters,
      };
      const fields = Object.entries(definitions).map(([name, definition]) =>
        parameterField(name, definition, initial),
      );
      const element = node('div', 'parameter-fields');
      element.append(...fields.map((field) => field.element));
      this.forms.set(this.name, { element, fields });
    }
    this.parametersElement.replaceChildren(this.forms.get(this.name).element);
  }

  values() {
    return Object.fromEntries(
      (this.forms.get(this.name)?.fields || [])
        .map((field) => [field.name, field.read()])
        .filter(([, value]) => value !== undefined),
    );
  }

  select(name) {
    this.preferred = name;
    if (!this.roles.some((role) => role.name === name)) {
      void this.load();
      return;
    }
    this.name = name;
    if (this.roleButton?.isConnected) this.showSelection();
    this.onChange();
  }

  restore(name, parameters) {
    if (!this.roles.some((role) => role.name === name)) {
      this.roles.push({
        name,
        parameters: Object.fromEntries(Object.keys(parameters).map((key) => [key, {}])),
      });
    }
    this.name = name;
    this.forms.delete(name);
    this.render(parameters);
    this.onChange();
  }
}

function roleText(role) {
  const text = node('span', 'role-text');
  const title = node('span', 'role-title', role.title || role.name);
  if (role.title && role.title.toLowerCase() !== role.name.toLowerCase())
    title.append(node('span', 'role-name', role.name));
  text.append(title);
  if (role.description) text.append(node('span', 'role-description', role.description));
  return text;
}

function choices(schema) {
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => ({ value, title: String(value) }));
  if (schema.oneOf?.length && schema.oneOf.every((option) => Object.hasOwn(option, 'const'))) {
    return schema.oneOf.map((option) => ({
      value: option.const,
      title: option.title || String(option.const),
    }));
  }
  return null;
}

function parameterField(name, definition, initial) {
  const schema = definition.schema || {};
  const title = definition.title || schema.title || name;
  const description = definition.description || schema.description;
  const element = node('div', 'parameter-field');
  const heading = node('div', 'parameter-heading');
  const label = node('label', '', title);
  const reset = node('button', 'parameter-reset', 'Reset');
  reset.type = 'button';
  reset.setAttribute('aria-label', `Reset ${title}`);
  heading.append(label, reset);
  element.append(heading);
  const hasDefault = Object.hasOwn(definition, 'default');
  let changed = Object.hasOwn(initial, name);
  let edited = false;
  const value = changed ? initial[name] : definition.default;
  const options = choices(schema);
  const itemOptions =
    schema.uniqueItems && schema.type === 'array' ? choices(schema.items || {}) : null;
  let control;
  let read;
  let set;

  if (options) {
    if (changed && !options.some((option) => equal(option.value, value)))
      options.push({ value, title: JSON.stringify(value) });
    control = node('select');
    const fallback = node(
      'option',
      '',
      hasDefault
        ? `Default: ${options.find((option) => equal(option.value, definition.default))?.title || JSON.stringify(definition.default)}`
        : 'Default',
    );
    fallback.value = '';
    control.append(fallback);
    options.forEach((option, index) => {
      const entry = node('option', '', option.title);
      entry.value = String(index);
      control.append(entry);
    });
    set = (value, explicit) => {
      const index = options.findIndex((option) => equal(option.value, value));
      control.value = explicit && index !== -1 ? String(index) : '';
    };
    read = () => (control.value === '' ? undefined : options[Number(control.value)].value);
  } else if (schema.type === 'boolean') {
    control = node('input', 'parameter-toggle');
    control.type = 'checkbox';
    set = (value) => {
      control.checked = value === true;
      control.indeterminate = value === undefined;
    };
    read = () => control.checked;
  } else if (itemOptions) {
    control = node('fieldset', 'parameter-options');
    control.append(node('legend', 'sr-only', title));
    const inputs = itemOptions.map((option) => {
      const label = node('label', 'parameter-option');
      const input = node('input');
      input.type = 'checkbox';
      label.append(input, node('span', '', option.title));
      control.append(label);
      return input;
    });
    set = (value) =>
      inputs.forEach((input, index) => {
        input.checked =
          Array.isArray(value) && value.some((entry) => equal(entry, itemOptions[index].value));
      });
    read = () =>
      itemOptions.filter((_, index) => inputs[index].checked).map((option) => option.value);
  } else if (['string', 'integer', 'number'].includes(schema.type)) {
    const multiline = schema.type === 'string' && schema.contentMediaType?.startsWith('text/');
    control = node(multiline ? 'textarea' : 'input');
    if (multiline) control.rows = 3;
    else
      control.type =
        schema.type !== 'string'
          ? 'number'
          : schema.writeOnly
            ? 'password'
            : { email: 'email', uri: 'url', date: 'date', time: 'time' }[schema.format] || 'text';
    if (schema.type !== 'string') {
      control.step = schema.multipleOf || (schema.type === 'integer' ? 1 : 'any');
      if (schema.minimum !== undefined) control.min = schema.minimum;
      if (schema.maximum !== undefined) control.max = schema.maximum;
    } else {
      if (schema.minLength !== undefined) control.minLength = schema.minLength;
      if (schema.maxLength !== undefined) control.maxLength = schema.maxLength;
    }
    control.placeholder = 'Not set';
    set = (value) => {
      control.value = value ?? '';
    };
    read = () => {
      if (schema.type === 'string') return control.value;
      if (!Number.isFinite(control.valueAsNumber)) throw new Error('Enter a number.');
      return control.valueAsNumber;
    };
  } else {
    control = node('textarea', 'parameter-json');
    control.rows = 3;
    control.spellcheck = false;
    control.placeholder = 'JSON';
    set = (value) => {
      control.value = value === undefined ? '' : JSON.stringify(value, null, 2);
    };
    read = () => {
      let value;
      try {
        value = JSON.parse(control.value);
      } catch {
        throw new Error('Enter valid JSON.');
      }
      if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))
        throw new Error('Enter a JSON object.');
      if (schema.type === 'array' && !Array.isArray(value)) throw new Error('Enter a JSON array.');
      return value;
    };
  }

  control.id = `parameter-${name}`;
  label.htmlFor = control.id;
  const hint = node('span', 'parameter-hint');
  const update = () => {
    reset.hidden = !changed;
    hint.textContent =
      changed || options
        ? ''
        : hasDefault
          ? 'Role default'
          : schema.type === 'boolean'
            ? 'Not set'
            : '';
  };
  const onInput = () => {
    edited = true;
    changed = !(options && control.value === '');
    control.setCustomValidity?.('');
    update();
  };
  control.addEventListener('input', onInput);
  control.addEventListener('change', onInput);
  reset.onclick = () => {
    changed = false;
    control.setCustomValidity?.('');
    set(definition.default, false);
    update();
  };
  set(value, changed);
  update();
  element.append(control);
  if (description) {
    const help = node('p', 'parameter-description', description);
    help.id = `parameter-description-${name}`;
    control.setAttribute('aria-describedby', help.id);
    element.append(help);
  }
  element.append(hint);
  return {
    name,
    element,
    read() {
      if (!changed) return undefined;
      if (!edited && Object.hasOwn(initial, name)) return initial[name];
      try {
        if (control.checkValidity && !control.checkValidity())
          throw new Error(control.validationMessage);
        return read();
      } catch (error) {
        control.setCustomValidity?.(error.message);
        control.reportValidity?.();
        control.focus();
        throw new Error(`${title}: ${error.message}`);
      }
    },
  };
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
