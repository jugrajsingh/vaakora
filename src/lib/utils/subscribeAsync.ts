/** Runs an async listener setup; the returned cleanup stops it once, even when called before the setup resolves. */
export function subscribeAsync(setup: () => Promise<() => void>): () => void {
  let stopped = false;
  let cleanup: (() => void) | undefined;
  void setup().then((stop) => {
    if (stopped) stop();
    else cleanup = stop;
  });
  return () => {
    stopped = true;
    cleanup?.();
    cleanup = undefined;
  };
}
