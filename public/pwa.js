const standalone = matchMedia('(display-mode: standalone)');
const installButton = document.getElementById('install');
let installPrompt;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  if (standalone.matches || navigator.standalone) return;
  installPrompt = event;
  installButton.hidden = false;
});

window.addEventListener('appinstalled', () => {
  installPrompt = undefined;
  installButton.hidden = true;
});

installButton.onclick = async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = undefined;
  installButton.hidden = true;
  try {
    await prompt.prompt();
  } catch (error) {
    console.warn('Could not open the install prompt.', error);
  }
};

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((error) => {
    console.warn('Could not cache Fleet for offline use.', error);
  });
}
