import { request } from './api.js';

const button = document.createElement('button');
button.className = 'connections-button';
button.textContent = 'Sign out';
button.onclick = async () => {
  await request('/session', { method: 'DELETE' });
  location.replace('/login.html');
};
document.querySelector('.sidebar-links').append(button);
