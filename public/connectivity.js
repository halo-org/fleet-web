export const SLOW_AFTER = 4000;
export const LOST_AFTER = 15_000;

/**
 * Says how long the connection has been down, so brief interruptions stay quiet.
 * A browser that reports itself offline counts as down even while streams look open.
 * Stages are `live`, `grace` while a problem may still resolve by itself,
 * `slow` once it is worth mentioning, and `lost` or `offline` once it is serious.
 */
export class Connectivity {
  live = false;
  connected = false;
  since = Date.now();
  timer;

  constructor(onChange, online = () => globalThis.navigator?.onLine !== false) {
    this.onChange = onChange;
    this.online = online;
    this.schedule();
  }

  get stage() {
    if (this.live) return 'live';
    const elapsed = Date.now() - this.since;
    if (elapsed < SLOW_AFTER) return 'grace';
    if (!this.online()) return 'offline';
    return elapsed < LOST_AFTER ? 'slow' : 'lost';
  }

  set(live) {
    live &&= this.online();
    if (live === this.live) return;
    this.live = live;
    if (live) this.connected = true;
    else this.since = Date.now();
    this.schedule();
    this.onChange();
  }

  /** Starts a new grace period, for when the browser itself triggers a reconnect. */
  restart() {
    if (this.live) return;
    this.since = Date.now();
    this.schedule();
    this.onChange();
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.live) return;
    const elapsed = Date.now() - this.since;
    const next = [SLOW_AFTER, LOST_AFTER].find((after) => after > elapsed);
    if (next === undefined) return;
    this.timer = setTimeout(() => {
      this.schedule();
      this.onChange();
    }, next - elapsed);
  }
}
