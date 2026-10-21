import { afterEach, expect, it, vi } from "vitest";
import { AUTH_OPERATION_TIMEOUT_MS, createAuthDeadline } from "@/lib/auth/deadline";
afterEach(() => vi.useRealTimers());
it("bounds the entire operation and aborts further provider fetches", async () => {
  vi.useFakeTimers();
  const deadline = createAuthDeadline();
  const result = deadline.execute(() => new Promise<never>(() => {}));
  const assertion = expect(result).rejects.toMatchObject({ status: 503, code: "AUTH_UNAVAILABLE" });
  await vi.advanceTimersByTimeAsync(AUTH_OPERATION_TIMEOUT_MS);
  await assertion;
  expect(deadline.signal.aborted).toBe(true);
});
it("cleans up the deadline after a successful call", async () => {
  vi.useFakeTimers();
  const deadline = createAuthDeadline();
  expect(await deadline.execute(async () => 42)).toBe(42);
  await vi.advanceTimersByTimeAsync(AUTH_OPERATION_TIMEOUT_MS * 2);
  expect(deadline.signal.aborted).toBe(false);
});
