/**
 * Where docker runs in a VM (macOS, Windows), the VM's shared filesystem keeps a file's entry for
 * about a second: a file the host replaced, created or removed just before a container starts
 * reads as its old self or as missing (measured on colima with virtiofs: stale up to 0.8 s after
 * the change, never at 1.0 s or later). Every host-side change to the checkout happens between
 * container runs, so the next run starts no sooner than this after the last one ended.
 */
export const sharedFilesystemSettleMs = process.platform === "linux" ? 0 : 1500;

/**
 * How long to wait before a container run: the settle time less what passed since the last run
 * ended. A sandbox's first run (no run yet, `lastEnded` 0) waits all of it, since the host has
 * just written the checkout and the run's home.
 */
export function settleWait(lastEnded: number, now: number, settleMs: number): number {
  const since = lastEnded === 0 ? 0 : now - lastEnded;
  return Math.max(0, settleMs - since);
}
