// Small async helpers for the UI: run actions one at a time, collapse refresh bursts, and recognise
// failures worth one retry. Pure (no DOM), so they are unit-tested.

/** `run(fn)` executes `fn`s strictly one after another; a failing one does not stop the ones queued behind it. */
export function serialQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };
}

/** Wrap `fn` so calls during a run share it: one in flight, at most one more afterwards. */
export function coalesce(fn) {
  let running = null;
  let again = false;
  return () => {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; await fn(); } while (again); } finally { running = null; }
    })();
    return running;
  };
}

/** A network failure or a gateway error from a proxy in front of the server: worth one retry. */
export const isTransient = (e) => !e?.status || [502, 503, 504].includes(e.status);

/** Message for a failed request: the server's own `{error}` when there is one, else something actionable. */
export function describeFailure(status, statusText, data) {
  if (data?.error) return data.error;
  if (!status) return 'Server not reachable (network error)';
  if ([502, 503, 504].includes(status)) return `Server not reachable (HTTP ${status}${statusText ? ` ${statusText}` : ''}); the proxy or the server dropped the request`;
  return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
}
