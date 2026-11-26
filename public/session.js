import { request } from './api.js';
import { disableNotifications } from './notifications.js';
import { icon } from './render.js';

const button = document.createElement('button');
button.type = 'button';
button.className = 'sidebar-row';
button.append(icon('sign-out'), 'Sign out');
button.onclick = async () => {
  await disableNotifications().catch((error) => {
    console.warn('Could not turn off notifications.', error);
  });
  await request('/session', { method: 'DELETE' });
  location.replace('/login.html');
};
document.querySelector('.sidebar-links').append(button);
