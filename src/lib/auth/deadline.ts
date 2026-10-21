import "server-only";
import { unavailable } from "./errors";

export const AUTH_OPERATION_TIMEOUT_MS = 5_000;

/** Bound the complete operation, including SDK backoff, rather than each fetch alone. */
export function createAuthDeadline(parent?: AbortSignal) {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  return {
    signal,
    async execute<T>(operation: () => Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(unavailable());
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), AUTH_OPERATION_TIMEOUT_MS);
        if (signal.aborted) onAbort();
      });
      try { return await Promise.race([operation(), stopped]); }
      finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
