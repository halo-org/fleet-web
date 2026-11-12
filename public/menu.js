/**
 * A popover menu below its button. Opening focuses the first item, arrow keys move between items,
 * and Escape, Tab or an outside tap closes it.
 */
export function enableMenu({ button, menu, available }) {
  const items = () => [...menu.querySelectorAll('[role=menuitem]')].filter((item) => !item.hidden);

  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    if (!available()) return event.preventDefault();
    const rect = button.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.right = `${document.documentElement.clientWidth - rect.right}px`;
  });
  menu.addEventListener('toggle', (event) => {
    const open = event.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    if (open) items()[0]?.focus({ preventScroll: true });
  });
  menu.addEventListener('keydown', (event) => {
    // Closing returns focus to the button, so Tab continues from there.
    if (event.key === 'Tab') return menu.hidePopover();
    const list = items();
    const index = list.indexOf(document.activeElement);
    const next = {
      ArrowDown: list[(index + 1) % list.length],
      ArrowUp: list.at(Math.max(index, 0) - 1),
      Home: list[0],
      End: list.at(-1),
    }[event.key];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  return {
    close() {
      if (menu.matches(':popover-open')) menu.hidePopover();
    },
  };
}
