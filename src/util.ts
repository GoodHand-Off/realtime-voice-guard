// Small timing helpers shared by the call supervisor, the watchdog and the Redis ledger.

/** Resolves after `ms`. The timer does not keep the process alive. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** Rejects with "`what` timed out after `ms` ms" if `promise` has not settled by then. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Throws a RangeError unless `value` is a finite number of at least `min`.
 * NaN would otherwise pass every comparison as false: a retry loop would never stop
 * and a timer of NaN milliseconds fires at once.
 */
export function assertFinite(name: string, value: number, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number of at least ${min} (got ${String(value)})`);
  }
  return value;
}

/** OpenAI ends every Realtime session within 60 minutes; after this long a call is certainly over. */
export const SESSION_LIMIT_MS = 61 * 60_000;
