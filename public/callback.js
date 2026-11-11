import { ApiError, request } from './api.js';

const status = document.querySelector('[role="status"]');
const url = location.href;
const state = new URLSearchParams(location.search).get('state');
const key = `fleet-oauth:${state}`;
const connection = state && localStorage.getItem(key);

function show(message, failed) {
  status.textContent = message;
  status.classList.toggle('error-text', failed);
}

if (!connection) {
  show(
    'This browser isn’t waiting for this sign-in. Copy this page’s address into the Providers dialog in Fleet to finish.',
    true,
  );
} else {
  try {
    const { data } = await request(
      `/connections/${encodeURIComponent(connection)}/authorizations/${encodeURIComponent(state)}/callback`,
      { method: 'POST', body: { url } },
    );
    if (data.status === 'failed') throw new ApiError(data.error || 'Sign-in failed.', 200);
    show('Signed in. You can close this window.', false);
    finish();
    window.close();
  } catch (error) {
    if (error instanceof ApiError) {
      finish();
      show(error.message, true);
    } else show('Could not reach Fleet. Reload this page to try again.', true);
  }
}

function finish() {
  localStorage.removeItem(key);
  history.replaceState(null, '', location.pathname);
}
