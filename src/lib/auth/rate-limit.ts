import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getAppOrigin } from "./config";
import { AuthHttpError, rateLimited, unavailable } from "./errors";

type Action = "login" | "signup" | "resend" | "recover" | "confirm";
type Policy = { limit: number; window: "5 m" | "1 h"; ms: number };
const policies: Record<Action, Policy> = {
  login: { limit: 30, window: "5 m", ms: 5 * 60_000 },
  signup: { limit: 5, window: "1 h", ms: 60 * 60_000 },
  resend: { limit: 10, window: "1 h", ms: 60 * 60_000 },
  recover: { limit: 10, window: "1 h", ms: 60 * 60_000 },
  confirm: { limit: 30, window: "5 m", ms: 5 * 60_000 },
};
// Per-account quotas bound distributed guessing/email flooding against one address.
const subjectPolicies: Partial<Record<Action, Policy>> = {
  login: { limit: 10, window: "5 m", ms: 5 * 60_000 },
  resend: { limit: 3, window: "1 h", ms: 60 * 60_000 },
  recover: { limit: 3, window: "1 h", ms: 60 * 60_000 },
};
const localBuckets = new Map<string, { count: number; reset: number }>();
let remote: { signature: string; limits: Map<string, Ratelimit>; redis: Redis } | undefined;

function clientIp(request: Request): string {
  const header = process.env.AUTH_TRUSTED_IP_HEADER?.trim().toLowerCase();
  // Only configure a header your reverse proxy overwrites with a SINGLE client IP.
  // Production requires this trust boundary; never silently apply one user quota to everyone.
  if (header && !/^[a-z0-9-]+$/.test(header)) throw unavailable("RATE_LIMIT_NOT_CONFIGURED");
  const value = header ? request.headers.get(header)?.trim() : undefined;
  if (value && isIP(value)) return value;
  if (process.env.NODE_ENV === "production" || header) throw unavailable("CLIENT_IP_UNAVAILABLE");
  // Local development has no trusted edge. Its local quota is explicitly shared.
  return "local-development";
}

async function check(key: string, { limit, window, ms }: Policy) {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url || token) {
    if (!url || !token) throw unavailable("RATE_LIMIT_UNAVAILABLE");
    try {
      const endpoint = new URL(url);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error();
    } catch { throw unavailable("RATE_LIMIT_NOT_CONFIGURED"); }
    const signature = createHmac("sha256", token).update(url).digest("hex");
    if (remote?.signature !== signature) remote = { signature, redis: new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(2500) }), limits: new Map() };
    const policy = `${limit}:${window}`;
    if (!remote.limits.has(policy)) {
      remote.limits.set(policy, new Ratelimit({ redis: remote.redis, limiter: Ratelimit.slidingWindow(limit, window),
        prefix: `scorecontrol:auth:${policy}`, analytics: false, timeout: 2000 }));
    }
    try {
      const result = await remote.limits.get(policy)!.limit(key);
      // The SDK otherwise permits requests on a limiter timeout. Auth must fail closed.
      if (result.reason === "timeout") throw unavailable("RATE_LIMIT_UNAVAILABLE");
      await result.pending;
      if (!result.success) throw rateLimited(Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)));
      return;
    } catch (error) {
      if (error instanceof AuthHttpError) throw error;
      throw unavailable("RATE_LIMIT_UNAVAILABLE");
    }
  }
  if (process.env.NODE_ENV === "production") throw unavailable("RATE_LIMIT_NOT_CONFIGURED");
  const now = Date.now();
  for (const [id, bucket] of localBuckets) if (bucket.reset <= now) localBuckets.delete(id);
  if (!localBuckets.has(key) && localBuckets.size >= 10_000) throw unavailable("RATE_LIMIT_UNAVAILABLE");
  const bucket = localBuckets.get(key) ?? { count: 0, reset: now + ms };
  // Like the Redis limiter, a rejected request does not consume quota.
  if (bucket.count >= limit) throw rateLimited(Math.max(1, Math.ceil((bucket.reset - now) / 1000)));
  bucket.count++;
  localBuckets.set(key, bucket);
}

function digest(value: string) {
  const secret = process.env.UPSTASH_REDIS_REST_TOKEN || "local-development-only";
  return createHmac("sha256", secret).update(`${getAppOrigin()}|${value}`).digest("hex");
}

/** Narrow quotas run first: a request they reject must not consume the shared global ceiling. */
export async function enforceRateLimit(request: Request, action: Action, subject?: string) {
  const policy = policies[action];
  await check(digest(`${action}:ip:${clientIp(request)}`), policy);
  if (subject) await enforceSubjectLimit(action, subject);
  // A separate, deliberately higher circuit breaker bounds total deployment abuse.
  await check(digest(`${action}:global`), { ...policy, limit: policy.limit * 1000 });
}

/** Per-account quota, for subjects only known after request-level checks (e.g. a resolved login). */
export async function enforceSubjectLimit(action: Action, subject: string) {
  const policy = subjectPolicies[action];
  if (policy) await check(digest(`${action}:subject:${subject.trim().toLowerCase()}`), policy);
}
