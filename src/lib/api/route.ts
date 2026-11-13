import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { withAuthenticatedRoute } from "@/lib/auth/guards";
import { authJson, errorResponse, noStore } from "@/lib/auth/http";
import { bearerToken, verifyAccessToken, type ApiCaller } from "./auth";

export type ApiHandler = (caller: ApiCaller) => Promise<NextResponse>;

/**
 * Wrapper for every project API route. Accepts the plugin's `Authorization: Bearer` token or the
 * web app's cookie session, and formats all errors with the contract's envelope.
 *
 * - Bearer: verified with Supabase; never reads or writes cookies, and skips the origin (CSRF) check,
 *   since browsers never attach bearer tokens on their own.
 * - Cookie: delegates to withAuthenticatedRoute (origin check on state-changing methods, session refresh).
 *
 * Authentication only. Each handler must still call requireProjectRole with `caller.id`.
 */
export async function withApiRoute(request: NextRequest, handler: ApiHandler): Promise<NextResponse> {
  let token: string | null;
  try {
    token = bearerToken(request);
  } catch (error) {
    return errorResponse(error);
  }
  if (token === null) {
    return withAuthenticatedRoute(request, async (identity) => noStore(await handler({ ...identity, via: "cookie" })));
  }
  try {
    const identity = await verifyAccessToken(token, request.signal);
    return noStore(await handler({ ...identity, via: "bearer" }));
  } catch (error) {
    return errorResponse(error);
  }
}

/** `{ data }` success response with no-store headers. */
export const apiJson = authJson;
