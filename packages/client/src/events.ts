import type { Unsubscribe } from "@berdyh/bridge-protocol";

/** Subscriber failures must not interrupt delivery to the other subscribers. */
export function events<T>() {
  const handlers = new Set<(value: T) => void>();
  const pending: T[] = [];
  let emitting = false;
  return {
    on(handler: (value: T) => void): Unsubscribe {
      const listener = (value: T) => handler(value);
      handlers.add(listener);
      return () => { handlers.delete(listener); };
    },
    emit(value: T) {
      pending.push(value);
      if (emitting) return;
      emitting = true;
      try {
        while (pending.length > 0) {
          const next = pending.shift()!;
          for (const handler of [...handlers]) {
            if (!handlers.has(handler)) continue;
            try { handler(next); } catch { /* Application callbacks do not own the link. */ }
          }
        }
      } finally {
        emitting = false;
      }
    },
    clear() { handlers.clear(); pending.length = 0; },
  };
}
