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

const updateButton = document.getElementById('update');

function offerUpdate() {
  updateButton.hidden = false;
  document.body.classList.add('update-available');
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  const { serviceWorker } = navigator;
  const controlled = !!serviceWorker.controller;
  let reloading = false;

  serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
    else if (controlled) offerUpdate();
  });

  serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      if (registration.waiting && controlled) offerUpdate();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && serviceWorker.controller) offerUpdate();
        });
      });

      const check = () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', check);
      setInterval(check, 30 * 60_000);

      updateButton.onclick = () => {
        updateButton.disabled = true;
        reloading = true;
        if (!registration.waiting) return location.reload();
        registration.waiting.postMessage('activate-update');
        setTimeout(() => location.reload(), 3000);
      };
    })
    .catch((error) => {
      console.warn('Could not cache Fleet for offline use.', error);
    });
}
