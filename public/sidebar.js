/**
 * Drag the mobile drawer with a finger. The drawer tracks the touch one to one, and a release
 * settles by projected position, so a quick flick works as well as a long drag.
 */
export function enableSidebarSwipe(open, close) {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('backdrop');
  const mobile = matchMedia('(max-width: 760px)');
  const isOpen = () => document.body.classList.contains('sidebar-open');
  let gesture;
  let settling;

  function clearInline() {
    for (const element of [sidebar, backdrop]) {
      element.style.removeProperty('transform');
      element.style.removeProperty('opacity');
      element.style.removeProperty('transition-duration');
    }
  }

  function reset() {
    gesture = undefined;
    document.body.classList.remove('sidebar-dragging');
    clearInline();
  }

  function position(offset) {
    sidebar.style.transform = `translate3d(${offset}px, 0, 0)`;
    backdrop.style.opacity = String(1 + offset / gesture.width);
  }

  document.addEventListener(
    'touchstart',
    (event) => {
      if (gesture) reset();
      if (!mobile.matches || event.touches.length !== 1 || document.querySelector('dialog[open]'))
        return;
      if (!getSelection().isCollapsed) return;
      if (event.target.closest('input, textarea, select, [contenteditable]')) return;

      const touch = event.touches[0];
      const opened = isOpen();
      if (!opened && event.target.closest('a, button, pre, code, table, .attachments')) return;

      gesture = {
        opened,
        x: touch.clientX,
        y: touch.clientY,
        width: sidebar.getBoundingClientRect().width,
        offset: opened ? 0 : -Infinity,
        samples: [],
        dragging: false,
      };
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (event) => {
      if (!gesture) return;
      if (
        event.touches.length !== 1 ||
        gesture.opened !== isOpen() ||
        !getSelection().isCollapsed
      ) {
        reset();
        return;
      }

      const touch = event.touches[0];
      const x = touch.clientX - gesture.x;
      const y = touch.clientY - gesture.y;
      if (!gesture.dragging) {
        if (Math.max(Math.abs(x), Math.abs(y)) < 8) return;
        // Leave vertical scrolling and swipes toward the current state to the browser.
        if (Math.abs(y) * 1.2 >= Math.abs(x) || (gesture.opened ? x > 0 : x < 0)) {
          reset();
          return;
        }
        if (!event.cancelable) {
          reset();
          return;
        }
        gesture.dragging = true;
        // Discount only the slop so the drawer stays under the finger.
        gesture.x += Math.sign(x) * 8;
        clearTimeout(settling);
        clearInline();
        document.body.classList.add('sidebar-dragging');
      }

      event.preventDefault();
      const distance = touch.clientX - gesture.x;
      gesture.offset = Math.max(
        -gesture.width,
        Math.min(0, distance - (gesture.opened ? 0 : gesture.width)),
      );
      gesture.samples.push({ x: touch.clientX, time: event.timeStamp });
      if (gesture.samples.length > 5) gesture.samples.shift();
      position(gesture.offset);
    },
    { passive: false },
  );

  document.addEventListener(
    'touchend',
    (event) => {
      if (!gesture?.dragging) {
        reset();
        return;
      }

      event.preventDefault();
      const { opened, offset, width, samples } = gesture;
      const recent = samples.filter((sample) => event.timeStamp - sample.time < 100);
      const first = recent[0];
      const last = recent.at(-1);
      const velocity =
        first && last && last.time > first.time ? (last.x - first.x) / (last.time - first.time) : 0;
      // A clear flick wins; otherwise settle where the drawer would come to rest.
      const shouldOpen =
        Math.abs(velocity) > 0.3 ? velocity > 0 : offset + velocity * 180 > -width / 2;
      const target = shouldOpen ? 0 : -width;
      const duration = Math.round(
        Math.min(320, Math.max(160, Math.abs(target - offset) / Math.max(Math.abs(velocity), 0.8))),
      );

      gesture = undefined;
      document.body.classList.remove('sidebar-dragging');
      for (const element of [sidebar, backdrop])
        element.style.transitionDuration = `${duration}ms`;
      sidebar.style.removeProperty('transform');
      backdrop.style.removeProperty('opacity');
      if (shouldOpen && !opened) open();
      else if (!shouldOpen && opened) close();
      clearTimeout(settling);
      settling = setTimeout(clearInline, duration + 50);
    },
    { passive: false },
  );

  document.addEventListener('touchcancel', reset, { passive: true });
  window.addEventListener('resize', () => {
    if (gesture) reset();
  });
}
