import { node, icon, copyButton } from './render.js';

export function renderRoleList(container, entries) {
  const roles = entries.toSorted((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
  const list = node('ul', 'role-list');
  list.setAttribute('aria-label', 'Roles');
  for (const role of roles) {
    const item = node('li');
    const link = node('a', 'role-entry');
    link.href = `#roles/${encodeURIComponent(role.name)}`;
    const heading = node('span', 'role-entry-heading');
    heading.append(node('span', 'role-entry-title', role.title || role.name));
    if (role.title) heading.append(node('code', 'role-entry-name', role.name));
    if (role.hidden) heading.append(node('span', 'role-badge', 'Hidden'));
    link.append(heading);
    if (role.description) link.append(node('span', 'role-entry-description', role.description));
    item.append(link);
    list.append(item);
  }
  container.replaceChildren(
    roles.length ? list : node('p', 'role-notice', 'No roles are defined.'),
  );
}

export function renderRole(container, role, onNewAgent) {
  const header = node('header', 'role-header');
  const title = node('h1', '', role.title || role.name);
  title.tabIndex = -1;
  const name = node('p', 'role-header-name');
  name.append(node('code', '', role.name));
  if (role.hidden) name.append(node('span', 'role-badge', 'Hidden'));
  header.append(title, name);
  if (role.description) header.append(node('p', 'role-header-description', role.description));
  if (!role.hidden) {
    const start = node('button', 'primary-button role-start', 'New agent with this role');
    start.type = 'button';
    start.onclick = onNewAgent;
    header.append(start);
  }

  const tools = Object.entries(role.tools || {});
  const parameters = Object.entries(role.parameters || {});
  const compaction = role.compaction || {};
  const sections = [
    section('Model', [selectionRow(role.model.name, '', role.model.config)]),
    section(
      'Tools',
      tools.map(([alias, tool]) => selectionRow(alias, tool.name, tool.config)),
      'No tools',
    ),
    role.workspace &&
      section('Workspace', [
        selectionRow(
          role.workspace.name,
          role.workspace.id ? `ID ${role.workspace.id}` : '',
          role.workspace.config,
        ),
      ]),
    parameters.length &&
      section(
        'Parameters',
        parameters.map(([name, parameter]) => parameterRow(role, name, parameter)),
      ),
    role.compaction &&
      section('Compaction', [
        compaction.threshold !== undefined &&
          row(node('span', '', 'Threshold'), String(compaction.threshold)),
        compaction.instructions !== undefined &&
          row(node('span', '', 'Instructions'), '', [prose(compaction.instructions)], false),
      ]),
    promptSection(role.system_prompt),
  ];
  container.replaceChildren(header, ...sections.filter(Boolean));
  return title;
}

export function renderRoleError(container, message, detail, retry) {
  const element = node('div', 'role-error');
  element.setAttribute('role', 'alert');
  element.append(node('p', '', message));
  if (detail) element.append(node('pre', '', detail));
  const actions = node('div', 'role-error-actions');
  if (retry) {
    const button = node('button', 'text-button', 'Retry');
    button.type = 'button';
    button.onclick = retry;
    actions.append(button);
  }
  element.append(actions);
  container.replaceChildren(element);
}

export function renderRoleEditor(container, edit, actions) {
  const form = node('form', 'role-editor');
  form.noValidate = true;
  const header = node('header', 'role-header');
  const title = node('h1', '', edit.name ? 'Edit role' : 'New role');
  title.tabIndex = -1;
  header.append(title);
  if (edit.name) {
    const name = node('p', 'role-header-name');
    name.append(node('code', '', edit.name));
    header.append(name);
  }
  form.append(header);
  if (actions.restored) {
    const notice = node('p', 'role-editor-notice', 'Unsaved changes were restored.');
    notice.append(textButton('Discard', actions.onDiscard));
    form.append(notice);
  }

  const controls = {
    name: !edit.name && input('name'),
    title: input('title'),
    description: textarea('description', 2),
    hidden: input('hidden', 'checkbox', 'parameter-toggle'),
    system_prompt: textarea('system_prompt', 12, 'role-editor-prompt'),
    settings: textarea('settings', 14, 'parameter-json'),
  };
  if (controls.name) {
    controls.name.required = true;
    controls.name.autocapitalize = 'none';
    controls.name.spellcheck = false;
  }
  controls.settings.spellcheck = false;
  for (const [key, control] of Object.entries(controls)) {
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = edit.fields[key];
    else control.value = edit.fields[key];
  }
  const fields = node('fieldset', 'role-editor-fields');
  fields.append(
    ...[
      controls.name &&
        editorField('Name', controls.name, 'Letters, digits, - and _. It cannot be changed later.'),
      editorField('Title', controls.title),
      editorField('Description', controls.description),
      editorField(
        'Hidden',
        controls.hidden,
        'Hidden roles stay usable by name but are not offered for new agents.',
      ),
      editorField('System prompt', controls.system_prompt),
      editorField(
        'Settings',
        controls.settings,
        'Model, tools, workspace, parameters and compaction as JSON.',
      ),
    ].filter(Boolean),
  );
  form.addEventListener('input', () => {
    for (const [key, control] of Object.entries(controls))
      if (control) edit.fields[key] = control.type === 'checkbox' ? control.checked : control.value;
    actions.onInput();
  });
  form.onsubmit = actions.onSubmit;

  const error = node('p', 'role-editor-error');
  error.setAttribute('role', 'alert');
  const buttons = node('div', 'role-editor-actions');
  const save = node('button', 'primary-button');
  save.type = 'submit';
  const cancel = node('a', 'text-button', 'Cancel');
  cancel.href = actions.cancel;
  cancel.onclick = actions.onCancel;
  const reload = textButton('Load current version', actions.onReload);
  buttons.append(save, cancel, reload);
  form.append(fields, error, buttons);
  container.replaceChildren(form);

  const update = (message = '') => {
    fields.disabled = edit.saving || !!edit.operation;
    save.disabled = edit.conflict;
    save.textContent = edit.saving
      ? 'Saving…'
      : edit.operation
        ? 'Retry save'
        : edit.name
          ? 'Save'
          : 'Create role';
    reload.hidden = !edit.conflict;
    reload.disabled = edit.saving;
    error.textContent = message;
    error.hidden = !message;
    form.setAttribute('aria-busy', String(edit.saving));
  };
  update();
  return { title, save, reload, update };
}

export function targetPath(target) {
  const base = { model: ['model'], tool: ['tools', target.tool], workspace: ['workspace'] }[
    target.type
  ];
  return [...(base || [target.type]), ...target.path].join('.');
}

export function targetValue(role, target) {
  const root = {
    model: role.model?.config,
    tool: role.tools?.[target.tool]?.config,
    workspace: role.workspace,
  }[target.type];
  return target.path.reduce((value, key) => (isObject(value) ? value[key] : undefined), root);
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textButton(label, onclick) {
  const button = node('button', 'text-button', label);
  button.type = 'button';
  button.onclick = onclick;
  return button;
}

function input(name, type = 'text', className = '') {
  const control = node('input', className);
  control.name = name;
  control.type = type;
  control.autocomplete = 'off';
  return control;
}

function textarea(name, rows, className = '') {
  const control = node('textarea', className);
  control.name = name;
  control.rows = rows;
  return control;
}

function editorField(label, control, description) {
  const element = node('div', 'parameter-field');
  const heading = node('div', 'parameter-heading');
  const text = node('label', '', label);
  control.id = `role-${control.name}`;
  text.htmlFor = control.id;
  heading.append(text);
  element.append(heading, control);
  if (description) {
    const help = node('p', 'parameter-description', description);
    help.id = `${control.id}-description`;
    control.setAttribute('aria-describedby', help.id);
    element.append(help);
  }
  return element;
}

function section(label, rows, empty) {
  const element = node('section', 'role-section');
  const heading = node('h2', 'role-section-heading', label);
  const items = rows.filter(Boolean);
  element.append(heading, ...items);
  if (!items.length && empty) element.append(node('p', 'role-empty', empty));
  return element;
}

function row(primary, secondary, details = [], collapsible = details.length > 0) {
  const element = node(collapsible ? 'details' : 'div', 'role-row');
  const line = node(collapsible ? 'summary' : 'div', 'role-line');
  const chevron = node('span', 'role-chevron');
  if (collapsible) chevron.append(icon('chevron'));
  line.append(chevron, primary);
  if (secondary)
    line.append(typeof secondary === 'string' ? node('span', 'role-value', secondary) : secondary);
  element.append(line);
  if (details.length) {
    const body = node('div', 'role-details');
    body.append(...details);
    element.append(body);
  }
  return element;
}

function selectionRow(name, secondary, config = {}) {
  const settings = Object.keys(config).length;
  return row(
    node('code', 'role-key', name),
    [secondary, settings && `${settings} ${settings === 1 ? 'setting' : 'settings'}`]
      .filter(Boolean)
      .join(' · '),
    settings ? [json(config)] : [],
  );
}

function parameterRow(role, name, parameter) {
  const value = targetValue(role, parameter.target);
  const secondary = node('span', 'role-value');
  secondary.append(node('code', '', targetPath(parameter.target)));
  if (value !== undefined) secondary.append(` = ${JSON.stringify(value)}`);
  const details = [];
  if (parameter.title) details.push(field('Name', node('code', '', name)));
  if (parameter.description) details.push(prose(parameter.description));
  if (parameter.schema) details.push(json(parameter.schema));
  return row(node('span', 'role-label', parameter.title || name), secondary, details);
}

function field(label, value) {
  const element = node('p', 'role-field');
  element.append(node('span', '', label), value);
  return element;
}

function prose(text) {
  return node('p', 'role-prose', text);
}

function json(value) {
  const pre = node('pre', 'role-json', JSON.stringify(value, null, 2));
  pre.tabIndex = 0;
  return pre;
}

function promptSection(prompt) {
  const element = node('section', 'role-section');
  const heading = node('div', 'role-section-heading');
  heading.append(node('h2', '', 'System prompt'));
  if (prompt) heading.append(copyButton(prompt, 'Copy system prompt'));
  const text = node('pre', 'role-prompt', prompt);
  text.tabIndex = 0;
  text.setAttribute('aria-label', 'System prompt');
  element.append(heading, prompt ? text : node('p', 'role-empty', 'No system prompt'));
  return element;
}
