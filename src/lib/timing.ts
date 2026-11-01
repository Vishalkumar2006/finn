import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request stage timings, sent as a Server-Timing header. Durations only; never content. */
const store = new AsyncLocalStorage<Record<string, number>>();

export function addTiming(name: string, ms: number) {
  const t = store.getStore();
  if (t) t[name] = (t[name] ?? 0) + ms;
}

export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    addTiming(name, Date.now() - start);
  }
}

export function withTiming<T>(fn: () => Promise<T>): Promise<{ value: T; header: string }> {
  const t: Record<string, number> = {};
  return store.run(t, async () => {
    const value = await timed("total", fn);
    return { value, header: Object.entries(t).map(([k, v]) => `${k};dur=${Math.round(v)}`).join(", ") };
  });
}
