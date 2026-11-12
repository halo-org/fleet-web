import { request } from './api.js';
import { icon } from './render.js';

const button = document.createElement('button');
button.className = 'connections-button';
button.textContent = 'Providers';
document.querySelector('.sidebar-links').prepend(button);

const dialog = document.createElement('dialog');
dialog.setAttribute('aria-labelledby', 'connections-title');
dialog.innerHTML = `
  <div class="dialog-content">
    <div class="dialog-heading">
      <h2 id="connections-title">Providers</h2>
      <button class="icon-button" aria-label="Close providers"></button>
    </div>
    <div class="connection-cards"></div>
    <p class="error-text" role="alert" hidden></p>
  </div>`;
document.body.append(dialog);
dialog.querySelector('.icon-button').append(icon('close'));
dialog.querySelector('.icon-button').onclick = () => dialog.close();
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

const cards = dialog.querySelector('.connection-cards');
const errorText = dialog.querySelector('[role="alert"]');
const attempts = new Map();

function element(tag, className, text) {
  const item = document.createElement(tag);
  item.className = className;
  if (text) item.textContent = text;
  return item;
}

function showError(error) {
  errorText.textContent = error?.message || '';
  errorText.hidden = !error;
}

button.onclick = async () => {
  dialog.showModal();
  showError(null);
  try {
    await refresh();
  } catch (error) {
    showError(error);
  }
};

async function refresh() {
  const [{ data: providers }, { data: connections }] = await Promise.all([
    request('/providers'),
    request('/connections'),
  ]);
  cards.replaceChildren(
    ...providers.map((provider) => {
      const card = element('section', 'provider-card');
      const heading = element('h3', 'provider-heading', provider.name);
      heading.append(element('span', 'provider-plugin', provider.plugin));
      card.append(heading);
      const items = connections.filter((connection) => connection.provider === provider.name);
      card.append(...items.map(render));
      if (!items.length) card.append(element('p', 'connection-account', 'No sign-in required.'));
      return card;
    }),
  );
  if (!providers.length) cards.append(element('p', '', 'No providers configured.'));
}

function render(connection) {
  const card = element('section', 'connection-card');
  card.append(element('h4', '', connection.title));
  const status = element(
    'p',
    'connection-account',
    connection.connected ? connection.email || 'Connected' : 'Not connected',
  );
  card.append(status);
  if (connection.description) card.append(element('p', '', connection.description));

  if (connection.connected) {
    const actions = element('div', 'connection-actions');
    if (connection.manage_url?.startsWith('https://')) {
      const manage = element('a', 'connection-manage', 'Manage connection');
      manage.href = connection.manage_url;
      manage.target = '_blank';
      manage.rel = 'noopener noreferrer';
      actions.append(manage);
    }
    const signOut = element('button', 'connections-button', 'Sign out');
    signOut.onclick = async () => {
      signOut.disabled = true;
      showError(null);
      try {
        const { data } = await request(
          `/connections/${encodeURIComponent(connection.id)}/credential`,
          { method: 'DELETE' },
        );
        await refresh();
        if (!data.revocation_confirmed)
          showError(
            new Error(
              'Signed out locally. Remote revocation could not be confirmed. You can disconnect the app in your provider’s settings.',
            ),
          );
      } catch (error) {
        signOut.disabled = false;
        showError(error);
      }
    };
    actions.append(signOut);
    card.append(actions);
  } else {
    for (const method of connection.methods) {
      if (method.kind === 'oauth') {
        const signIn = element('button', 'primary-button', method.title);
        signIn.disabled = attempts.has(connection.id);
        signIn.onclick = () => authorize(connection, method, signIn);
        card.append(signIn);
      } else if (method.kind === 'api_key') {
        const form = element('form', 'connection-key');
        const key = element('input', '');
        key.type = 'password';
        key.placeholder = 'API key';
        key.autocomplete = 'off';
        key.required = true;
        key.setAttribute('aria-label', `${connection.title} API key`);
        const save = element('button', 'primary-button', method.title);
        save.type = 'submit';
        form.append(key, save);
        form.onsubmit = async (event) => {
          event.preventDefault();
          save.disabled = true;
          showError(null);
          try {
            await request(`/connections/${encodeURIComponent(connection.id)}/credential`, {
              method: 'PUT',
              body: { method: method.name, key: key.value },
            });
            key.value = '';
            await refresh();
          } catch (error) {
            save.disabled = false;
            showError(error);
          }
        };
        card.append(form);
      }
    }
  }
  const attempt = attempts.get(connection.id);
  if (attempt) {
    card.append(element('p', '', 'Complete sign-in in the browser.'));
    const link = element('a', 'connection-manage', 'Open sign-in page');
    link.href = attempt.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    card.append(link);
    card.append(
      element(
        'p',
        '',
        'If the sign-in page can’t reach Fleet, paste the address it finished on here.',
      ),
    );
    card.append(paste(connection, attempt));
  }
  return card;
}

function paste(connection, attempt) {
  const form = element('form', 'connection-key');
  const address = element('input', '');
  address.type = 'url';
  address.placeholder = 'Sign-in page address';
  address.autocomplete = 'off';
  address.required = true;
  address.setAttribute('aria-label', `${connection.title} sign-in address`);
  const finish = element('button', 'primary-button', 'Finish sign-in');
  finish.type = 'submit';
  form.append(address, finish);
  form.onsubmit = async (event) => {
    event.preventDefault();
    finish.disabled = true;
    showError(null);
    try {
      await request(
        `/connections/${encodeURIComponent(connection.id)}/authorizations/${encodeURIComponent(attempt.id)}/callback`,
        { method: 'POST', body: { url: address.value } },
      );
      address.value = '';
    } catch (error) {
      showError(error);
    } finally {
      finish.disabled = false;
    }
  };
  return form;
}

function redirectUri(method) {
  if (!method.redirect_uri || location.protocol !== 'http:' || location.hostname !== '127.0.0.1')
    return undefined;
  const declared = new URL(method.redirect_uri);
  if (declared.protocol !== 'http:' || declared.hostname !== '127.0.0.1') return undefined;
  if (declared.port !== '0' && (declared.port || '80') !== (location.port || '80'))
    return undefined;
  return location.origin + declared.pathname;
}

async function authorize(connection, method, signIn) {
  const popup = window.open('about:blank', '_blank');
  let opened = false;
  let attempt;
  if (popup) popup.opener = null;
  signIn.disabled = true;
  showError(null);
  try {
    ({ data: attempt } = await request(
      `/connections/${encodeURIComponent(connection.id)}/authorizations`,
      {
        method: 'POST',
        body: { method: method.name, redirect_uri: redirectUri(method) },
      },
    ));
    localStorage.setItem(`fleet-oauth:${attempt.id}`, connection.id);
    attempts.set(connection.id, attempt);
    if (popup) {
      popup.location.href = attempt.url;
      opened = true;
    }
    await refresh();
    await poll(connection, attempt);
  } catch (error) {
    if (popup && !opened) popup.close();
    showError(error);
  } finally {
    if (attempt) localStorage.removeItem(`fleet-oauth:${attempt.id}`);
    attempts.delete(connection.id);
    signIn.disabled = false;
    await refresh().catch(showError);
  }
}

async function poll(connection, attempt) {
  const deadline = Date.now() + 11 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { data } = await request(
      `/connections/${encodeURIComponent(connection.id)}/authorizations/${attempt.id}`,
      {
        signal: AbortSignal.timeout(40_000),
      },
    );
    if (data.status === 'failed')
      throw new Error(data.error || 'Sign-in failed. Please try again.');
    if (data.status === 'complete') {
      if (!dialog.open) dialog.showModal();
      return;
    }
  }
  throw new Error('Sign-in expired. Please try again.');
}
