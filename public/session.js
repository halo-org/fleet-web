import { request } from './api.js';
import { disableNotifications } from './notifications.js';

const button = document.createElement('button');
button.className = 'connections-button';
button.textContent = 'Sign out';
button.onclick = async () => {
  await disableNotifications().catch((error) => {
    console.warn('Could not turn off notifications.', error);
  });
  await request('/session', { method: 'DELETE' });
  location.replace('/login.html');
};
document.querySelector('.sidebar-links').append(button);
