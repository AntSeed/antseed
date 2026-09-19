/**
 * Hard time budget immune to stuck I/O: resolves with the task's result when
 * it lands inside budgetMs, otherwise with fallback(). Unlike an
 * AbortController cap this cannot be defeated by a fetch that ignores its
 * abort signal (e.g. a DNS lookup wedged on the libuv threadpool) — the
 * task keeps running in the background and later cycles pick up whatever
 * it cached. A rejected task also resolves to fallback().
 */
export function raceBudget<T>(task: Promise<T>, budgetMs: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => { resolve(fallback()); }, budgetMs);
    task.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback()); },
    );
  });
}
