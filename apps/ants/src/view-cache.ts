const DEFAULT_TTL_MS = 20_000;

/**
 * Read-side cache for dashboard views. Public Base RPCs throttle bursts, and
 * the failover provider fans a slow call out to every endpoint, so four tabs
 * loading at once used to turn into minutes of 429 backoff. Reads are run one
 * at a time (each view already batches its own calls), identical concurrent
 * requests share one load, and results stay fresh for `ttlMs` unless a job
 * invalidates them.
 */
export class ViewCache {
  private readonly entries = new Map<string, { at: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value as T);
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const task = this.queue.then(load, load);
    this.queue = task.catch(() => undefined);
    this.inflight.set(key, task);
    // Settle in the first continuation so a caller awaiting `task` never sees a stale in-flight entry.
    const settle = () => { if (this.inflight.get(key) === task) this.inflight.delete(key); };
    task.then((value) => { this.entries.set(key, { at: Date.now(), value }); settle(); }, settle);
    return task;
  }

  /** Drop every cached view; in-flight loads finish and are cached as usual. */
  invalidate(): void {
    this.entries.clear();
  }
}
