import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest, type NextResponse } from "next/server";
import { createAuthContext, type AuthContext } from "@/lib/supabase/server";
import { assertMutationOrigin, errorResponse } from "./http";
import { unauthenticated } from "./errors";
import { getIdentity, type AuthIdentity } from "./user";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Route Handler adapter. Rejects cross-origin state-changing requests before any lookup.
 * Authentication does not replace resource authorization; derive ownership from `user.id`.
 */
export async function withAuthenticatedRoute(request: NextRequest,
  handler: (user: AuthIdentity, client: SupabaseClient) => Promise<NextResponse>) {
  let context: AuthContext | undefined;
  try {
    if (!SAFE_METHODS.has(request.method)) assertMutationOrigin(request);
    context = createAuthContext(request);
    const user = await context.execute(() => getIdentity(context!.client));
    if (!user) {
      context.bridge.clear();
      return context.bridge.apply(errorResponse(unauthenticated()));
    }
    return context.bridge.apply(await handler(user, context.client));
  } catch (error) {
    context?.bridge.rollback(true);
    const response = errorResponse(error);
    return context ? context.bridge.apply(response) : response;
  }
}
