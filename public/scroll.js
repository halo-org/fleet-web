/**
 * Where a view that follows new content should scroll. It moves to the end until the newest
 * response would start above the viewport, then stops there so the response reads from its top.
 * Small steps are immediate, like text pushing up as it streams. A large step would snap, so it
 * stays put when the response start is already comfortably visible and glides otherwise.
 * It never scrolls back up. `responseTop` is in scroll coordinates and may be undefined.
 */
export function followPosition({ scrollTop, scrollHeight, clientHeight, responseTop }) {
  const end = Math.max(0, scrollHeight - clientHeight);
  let top = Math.max(scrollTop, end);
  let follow = true;
  if (responseTop !== undefined && scrollTop <= responseTop && responseTop < end) {
    top = responseTop;
    follow = false;
  }
  if (top - scrollTop <= clientHeight / 4) return { top, follow, smooth: false };
  if (
    responseTop !== undefined &&
    scrollTop <= responseTop &&
    responseTop - scrollTop <= (clientHeight * 2) / 3
  )
    return { top: scrollTop, follow: false, smooth: false };
  return { top, follow, smooth: true };
}

export function distanceFromEnd(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}
