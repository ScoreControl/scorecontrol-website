import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { isSessionCookie } from "@/lib/auth/cookies";
import { isInvalidSession, providerError } from "@/lib/auth/errors";
import { logAuthFailure, noStore } from "@/lib/auth/http";
import { createAuthContext, type AuthContext } from "./server";

/** Refresh cookies only. Protected pages and APIs must independently verify their user. */
export async function updateSession(request: NextRequest) {
  if (!request.cookies.getAll().some(({ name }) => isSessionCookie(name))) return NextResponse.next({ request });
  let context: AuthContext | undefined;
  try {
    context = createAuthContext(request);
    const { client, bridge, execute } = context;
    const { data, error } = await execute(() => client.auth.getClaims());
    if (error && !isInvalidSession(error)) throw providerError(error);
    if (error || !data?.claims) bridge.clear();
  } catch (error) {
    // Public pages stay available. Do not turn an outage into a logout, or lose a
    // refresh token already rotated before a later provider request failed.
    context?.bridge.rollback(true);
    logAuthFailure(error); // Sanitized server-side diagnostics; no identity is asserted.
  }
  if (!context) return noStore(NextResponse.next({ request }));
  const nextCookies = context.bridge.getAll();
  const names = new Set(nextCookies.map(({ name }) => name));
  for (const { name } of request.cookies.getAll()) if (!names.has(name)) request.cookies.delete(name);
  for (const { name, value } of nextCookies) request.cookies.set(name, value);
  return context.bridge.apply(noStore(NextResponse.next({ request })));
}
