const HOLD_MS = 400;
const SLOP = 10;

/**
 * Holding the send button shows its delivery options. Slide onto one and release, or release
 * and tap one. Right-click and the context menu key open them too. A plain tap is unchanged.
 */
export function enableDeliveryChoice({ button, menu, composer, available }) {
  const options = [...menu.querySelectorAll('button')];
  let press = null;
  let suppressClick = false;
  // Only refocus the composer if it had focus, so a closed on-screen keyboard stays closed.
  let composerHadFocus = false;

  const isOpen = () => !menu.hidden;
  const optionAt = (x, y) => {
    const target = document.elementFromPoint(x, y);
    return options.find((option) => option.contains(target)) || null;
  };
  const highlight = (active) => {
    for (const option of options) option.classList.toggle('active', option === active);
  };
  const open = () => {
    composerHadFocus = document.activeElement === composer;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  };
  const close = (focus) => {
    if (!isOpen()) return;
    const hadFocus = menu.contains(document.activeElement);
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    highlight(null);
    if (hadFocus) (focus || button).focus();
  };
  const choose = (option) => {
    close(composerHadFocus ? composer : button);
    button.form.requestSubmit(option);
  };
  const endPress = () => {
    clearTimeout(press?.timer);
    press = null;
  };

  button.addEventListener('pointerdown', (event) => {
    suppressClick = false;
    if (!event.isPrimary || event.button !== 0 || !available()) return;
    button.setPointerCapture(event.pointerId);
    const timer = setTimeout(() => {
      press.held = true;
      suppressClick = true;
      open();
      navigator.vibrate?.(10);
    }, HOLD_MS);
    press = { x: event.clientX, y: event.clientY, timer, held: false };
  });
  button.addEventListener('pointermove', (event) => {
    if (!press) return;
    if (press.held) highlight(optionAt(event.clientX, event.clientY));
    else if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > SLOP)
      clearTimeout(press.timer);
  });
  button.addEventListener('pointerup', (event) => {
    if (!press?.held) return endPress();
    endPress();
    const option = optionAt(event.clientX, event.clientY);
    if (option) choose(option);
    else if (!button.contains(document.elementFromPoint(event.clientX, event.clientY))) close();
    else highlight(null);
  });
  button.addEventListener('pointercancel', () => {
    if (press?.held) close();
    endPress();
  });
  // Pointer capture sends the click to the button after a hold; it must not also send.
  button.addEventListener(
    'click',
    (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!available()) return;
    open();
    if (!press && document.activeElement === button) options[0].focus();
  });

  for (const option of options) {
    option.addEventListener('pointerdown', (event) => {
      if (document.activeElement === composer) event.preventDefault();
    });
    option.addEventListener('click', (event) => {
      event.preventDefault();
      choose(option);
    });
  }
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) close();
    },
    { capture: true },
  );
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close();
    }
  });

  return { close };
}
