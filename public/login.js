const form = document.querySelector('form');
const errorText = document.querySelector('[role="alert"]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorText.hidden = true;
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: form.elements.token.value }),
  }).catch(() => null);
  if (response?.ok) return location.replace('/');
  errorText.textContent =
    response?.status === 401 ? 'That token is not valid.' : 'Could not sign in. Try again.';
  errorText.hidden = false;
});
