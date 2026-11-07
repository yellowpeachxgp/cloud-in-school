// Per-user latest-state queue. Payloads are built at send time, never cached.
export function createProfileSyncQueue(send, { intervalMs = 30_000, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const states = new Map();
  let closing = false;
  let closePromise;
  function state(key) {
    if (!states.has(key)) states.set(key, { dirty: false, nextAt: 0, timer: null, flight: null });
    return states.get(key);
  }
  function schedule(key, st) {
    if (closing || st.timer || st.flight || !st.dirty) return;
    const delay = Math.max(0, st.nextAt - now());
    st.timer = setTimer(() => { st.timer = null; void run(key, st); }, delay);
    st.timer?.unref?.();
  }
  function run(key, st) {
    if (st.flight) return st.flight;
    st.dirty = false;
    // Defer send so flight is installed before synchronous completion/throw.
    st.flight = Promise.resolve().then(() => send(key)).then((result) => {
      if (result?.ok === false) st.dirty = true;
    }, () => { st.dirty = true; }).finally(() => {
      st.flight = null;
      st.nextAt = now() + intervalMs;
      schedule(key, st);
    });
    return st.flight;
  }
  function request(key) {
    if (closing) return Promise.resolve(false);
    const st = state(key);
    st.dirty = true;
    if (st.flight) return st.flight;
    if (now() < st.nextAt) { schedule(key, st); return Promise.resolve(); }
    if (st.timer) { clearTimer(st.timer); st.timer = null; }
    return run(key, st);
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const st of states.values()) {
        if (st.timer) clearTimer(st.timer);
        st.timer = null;
      }
      await Promise.all([...states.values()].map(st => st.flight));
      // One final latest snapshot per dirty user, no infinite retry on shutdown.
      await Promise.all([...states].filter(([,st]) => st.dirty).map(([key,st]) => run(key,st)));
      return { pending: [...states.values()].filter(st => st.dirty).length };
    })();
    return closePromise;
  }
  return { request, close };
}
