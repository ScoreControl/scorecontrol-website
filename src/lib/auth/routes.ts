import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { createAuthContext, createEphemeralClient, type AuthContext } from "@/lib/supabase/server";
import { getAppOrigin, getAuthConfig } from "./config";
import { createAuthDeadline } from "./deadline";
import {
  AuthHttpError, invalidCredentials, isDuplicateAccount, isInvalidSession, providerError, unauthenticated, unavailable,
  usernameTaken,
} from "./errors";
import { authJson, errorResponse, logAuthFailure, noStore, readJson } from "./http";
import { claimUsername, findUsernameAccount, resolveLoginIdentity } from "./usernames";
import { CONFIRM_PATH, HOME_PATH, RESET_PASSWORD_PATH, loginPath, type LoginError } from "./paths";
import { hasRecentEmailProof, reauthenticationRequired, updatePassword, verifyCurrentPassword } from "./password";
import { enforceRateLimit, enforceSubjectLimit } from "./rate-limit";
import { authUser, getCurrentUser, getIdentity } from "./user";
import {
  changePasswordSchema, claimUsernameSchema, emailRequestSchema, loginSchema, logoutSchema,
  resetPasswordSchema, signupSchema, tokenHashSchema, validate,
} from "./validation";

type Context = () => AuthContext;
async function run(request: NextRequest, handler: (context: Context) => Promise<NextResponse>, preserveSession = false) {
  let context: AuthContext | undefined;
  const getContext = () => context ??= createAuthContext(request);
  try {
    const response = await handler(getContext);
    return context ? context.bridge.apply(response) : response;
  } catch (error) {
    // Reads can commit a refresh before a later /user lookup fails. Mutations still
    // discard uncommitted sign-in/signup state.
    context?.bridge.rollback(preserveSession);
    const response = errorResponse(error);
    return context ? context.bridge.apply(response) : response;
  }
}

export function handleSignup(request: NextRequest) {
  return run(request, async (getContext) => {
    const input = validate(signupSchema, await readJson(request));
    await enforceRateLimit(request, "signup");
    if (await findUsernameAccount(input.username)) throw usernameTaken();
    const { client, bridge, execute } = getContext();
    bridge.setMode(false);
    const { data, error } = await execute(() => client.auth.signUp({ email: input.email, password: input.password,
      options: { emailRedirectTo: `${getAppOrigin()}${CONFIRM_PATH}`, data: { scorecontrol_username: input.username } } }));
    if (error) {
      if (isDuplicateAccount(error)) {
        bridge.rollback();
        return authJson({ status: "confirmation_required" }, 202);
      }
      // The database trigger enforces uniqueness atomically. A competing signup
      // can win after preflight; report the conflict without leaving a second account.
      if (await findUsernameAccount(input.username)) throw usernameTaken();
      throw providerError(error);
    }
    if (!data.session || !data.user) return authJson({ status: "confirmation_required" }, 202);
    bridge.savePreference();
    bridge.commitSession();
    return authJson({ status: "authenticated", user: await authUser(data.user) }, 201);
  });
}

export function handleLogin(request: NextRequest) {
  return run(request, async (getContext) => {
    const input = validate(loginSchema, await readJson(request));
    await enforceRateLimit(request, "login");
    const identity = await resolveLoginIdentity(input.identifier ?? input.email!);
    if (!identity) throw invalidCredentials();
    await enforceSubjectLimit("login", identity.email);
    const { client, bridge, execute } = getContext();
    bridge.setMode(input.rememberMe);
    const { data, error } = await execute(() => client.auth.signInWithPassword({ email: identity.email, password: input.password }));
    if (error) throw providerError(error);
    if (!data.session || !data.user) throw invalidCredentials();
    // Defend against a stale mapping resolving to an email now owned by another UUID.
    if (identity.id && data.user.id !== identity.id) {
      await execute(() => client.auth.signOut({ scope: "local" }));
      throw invalidCredentials();
    }
    bridge.savePreference();
    bridge.commitSession();
    return authJson({ user: await authUser(data.user) });
  });
}

export function handleMe(request: NextRequest) {
  return run(request, async (getContext) => {
    const { client, bridge, execute } = getContext();
    if (!bridge.hasSession()) return errorResponse(unauthenticated());
    const user = await execute(() => getCurrentUser(client));
    if (!user) {
      bridge.clear();
      return errorResponse(unauthenticated());
    }
    return authJson({ user });
  }, true);
}

export function handleLogout(request: NextRequest) {
  return run(request, async (getContext) => {
    validate(logoutSchema, await readJson(request));
    const { client, bridge, execute } = getContext();
    let failure = false;
    if (bridge.hasSession()) {
      try {
        const { error } = await execute(() => client.auth.signOut({ scope: "local" }));
        failure = Boolean(error && !isInvalidSession(error));
      } catch { failure = true; }
    }
    bridge.clear(true);
    if (failure) return errorResponse(new AuthHttpError(503, "LOGOUT_INCOMPLETE",
      "Signed out on this browser. Remote session revocation could not be confirmed."));
    return noStore(new NextResponse(null, { status: 204 }));
  });
}

export function handleResend(request: NextRequest) {
  return run(request, async (getContext) => {
    const input = validate(emailRequestSchema, await readJson(request));
    await enforceRateLimit(request, "resend", input.email);
    const { client, execute } = getContext();
    const { error } = await execute(() => client.auth.resend({ type: "signup", email: input.email,
      options: { emailRedirectTo: `${getAppOrigin()}${CONFIRM_PATH}` } }));
    if (error && !isDuplicateAccount(error) && error.code !== "user_not_found") throw providerError(error);
    return authJson({ status: "accepted" }, 202);
  });
}

/** Failures redirect to the login page: this route is opened by browser navigation, not fetch. */
function callbackFailure(error: unknown): LoginError {
  const failure = error instanceof AuthHttpError ? error : providerError(error);
  if (failure.status === 429) return "rate_limited";
  if (failure.status >= 500) {
    logAuthFailure(failure);
    return "unavailable";
  }
  return "confirmation_failed";
}

function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  return values.length === 1 && values[0] ? values[0] : undefined;
}

/**
 * Email link: a signup token-hash link (any device) or a default-template same-browser PKCE code.
 * Reset emails link straight to the reset page's URL fragment instead, so reset tokens never reach a server.
 */
export async function handleConfirm(request: NextRequest) {
  let context: AuthContext | undefined;
  let origin: string;
  try { origin = getAppOrigin(); } catch (error) { return errorResponse(error); }
  const redirect = (path: string) => {
    const response = noStore(NextResponse.redirect(new URL(path, origin), 303));
    response.headers.set("Referrer-Policy", "no-referrer");
    return context ? context.bridge.apply(response) : response;
  };
  const params = request.nextUrl.searchParams;
  try {
    if (params.has("error")) return redirect(loginPath({ error: "confirmation_failed" }));
    if (params.has("token_hash")) return redirect(await verifyEmailLink(request, params));
    const code = single(params, "code");
    if (!code || code.length > 2048) return redirect(loginPath({ error: "confirmation_failed" }));
    await enforceRateLimit(request, "confirm");
    context = createAuthContext(request);
    context.bridge.setMode(false);
    const { data, error } = await context.execute(() => context!.client.auth.exchangeCodeForSession(code));
    if (error || !data.session || !data.user) {
      context.bridge.rollback();
      return redirect(loginPath({ error: error ? callbackFailure(error) : "confirmation_failed" }));
    }
    context.bridge.savePreference();
    // A same-browser recovery link signs in with a recovery session for setting a new password.
    // auth-js returns redirectType at runtime (documented in its JSDoc) but omits it from the type.
    const recovery = (data as { redirectType?: string | null }).redirectType === "recovery";
    return redirect(recovery ? RESET_PASSWORD_PATH : HOME_PATH);
  } catch (error) {
    context?.bridge.rollback();
    // Credentials never appear in redirects or logs.
    return redirect(loginPath({ error: callbackFailure(error) }));
  }
}

/** Social sign-in providers enabled in the Supabase dashboard. */
export type OAuthProvider = "google";

/**
 * Starts social sign-in. Opened by browser navigation (a link), not fetch: it redirects to the
 * provider's consent page. The SDK stores the PKCE code verifier in an HttpOnly cookie, so only
 * this browser can finish the sign-in. The provider returns to /auth/confirm, which exchanges the
 * code for a session exactly like a same-browser email link. New social accounts have no username
 * yet; the frontend sends them to the username form (`username: null` from /api/auth/me).
 */
export async function handleOAuthStart(request: NextRequest, provider: OAuthProvider) {
  let context: AuthContext | undefined;
  let origin: string;
  try { origin = getAppOrigin(); } catch (error) { return errorResponse(error); }
  const redirect = (url: string) => {
    const response = noStore(NextResponse.redirect(new URL(url, origin), 303));
    response.headers.set("Referrer-Policy", "no-referrer");
    return context ? context.bridge.apply(response) : response;
  };
  try {
    await enforceRateLimit(request, "login");
    context = createAuthContext(request);
    // Session-only cookies, like email-link sign-in; "remember me" is a password-login option.
    context.bridge.setMode(false);
    const { data, error } = await context.execute(() => context!.client.auth.signInWithOAuth({
      provider, options: { redirectTo: `${origin}${CONFIRM_PATH}`, skipBrowserRedirect: true },
    }));
    if (error) throw error;
    // Only ever redirect to our own Supabase project's authorize endpoint.
    const target = data.url ? new URL(data.url) : undefined;
    if (!target || target.origin !== getAuthConfig().url) throw unavailable();
    return redirect(target.toString());
  } catch (error) {
    context?.bridge.rollback();
    return redirect(loginPath({ error: callbackFailure(error) }));
  }
}

export function handleGoogleSignIn(request: NextRequest) {
  return handleOAuthStart(request, "google");
}

/**
 * Signup token-hash links work on any device. They never create a browser session, so a link from
 * someone else's mailbox cannot sign this browser into their account.
 */
async function verifyEmailLink(request: NextRequest, params: URLSearchParams): Promise<string> {
  const type = single(params, "type");
  const parsed = tokenHashSchema.safeParse(single(params, "token_hash"));
  if (!parsed.success || type !== "email") return loginPath({ error: "confirmation_failed" });
  await enforceRateLimit(request, "confirm");
  const deadline = createAuthDeadline(request.signal);
  const client = createEphemeralClient(deadline.signal);
  const { data, error } = await deadline.execute(() => client.auth.verifyOtp({ type, token_hash: parsed.data }));
  if (error) return loginPath({ error: callbackFailure(error) });
  // Best effort: the verified session exists only in memory and is discarded either way.
  if (data.session) await deadline.execute(() => client.auth.signOut({ scope: "local" })).catch(() => undefined);
  return loginPath({ status: "email_confirmed" });
}

/** Generic response for known and unknown addresses. */
export function handleForgotPassword(request: NextRequest) {
  return run(request, async (getContext) => {
    const input = validate(emailRequestSchema, await readJson(request));
    await enforceRateLimit(request, "recover", input.email);
    const { client, execute } = getContext();
    const { error } = await execute(() => client.auth.resetPasswordForEmail(input.email,
      { redirectTo: `${getAppOrigin()}${CONFIRM_PATH}` }));
    if (error && error.code !== "user_not_found") throw providerError(error);
    return authJson({ status: "accepted" }, 202);
  });
}

/**
 * Completes a reset link: the reset page reads the token from its URL fragment and posts it here.
 * Verifies it, signs this browser in, and sets the new password.
 */
export function handleResetPassword(request: NextRequest) {
  return run(request, async (getContext) => {
    const input = validate(resetPasswordSchema, await readJson(request));
    await enforceRateLimit(request, "confirm");
    const { client, bridge, execute } = getContext();
    bridge.setMode(false);
    const { data, error } = await execute(() => client.auth.verifyOtp({ type: "recovery", token_hash: input.tokenHash }));
    if (error || !data.session || !data.user) {
      const failure = error && providerError(error);
      if (failure && (failure.status >= 500 || failure.status === 429)) throw failure;
      throw new AuthHttpError(400, "RECOVERY_LINK_INVALID", "This reset link is invalid or has expired. Request a new one.");
    }
    bridge.savePreference();
    // The link is now used. Keep the recovery session so a rejected password can be retried
    // through POST /api/auth/password without another email.
    bridge.commitSession();
    return authJson(await updatePassword(client, execute, input.password));
  });
}

/** Signed-in password change. Requires the current password unless the session recently proved email control. */
export function handleChangePassword(request: NextRequest) {
  return run(request, async (getContext) => {
    const input = validate(changePasswordSchema, await readJson(request));
    await enforceRateLimit(request, "login");
    const { client, bridge, execute } = getContext();
    const user = await execute(() => getIdentity(client));
    if (!user) {
      bridge.clear();
      return errorResponse(unauthenticated());
    }
    if (!(await hasRecentEmailProof(client, execute))) {
      if (!input.currentPassword) {
        throw new AuthHttpError(400, "CURRENT_PASSWORD_REQUIRED", "Enter your current password.",
          { currentPassword: ["Enter your current password."] });
      }
      if (!user.email) throw reauthenticationRequired();
      await enforceSubjectLimit("login", user.email);
      await verifyCurrentPassword(user.email, input.currentPassword, user.id, request.signal);
    }
    return authJson(await updatePassword(client, execute, input.password));
  }, true);
}

/** Accounts created before usernames were required claim one after signing in. */
export function handleClaimUsername(request: NextRequest) {
  return run(request, async (getContext) => {
    const input = validate(claimUsernameSchema, await readJson(request));
    await enforceRateLimit(request, "signup");
    const { client, bridge, execute } = getContext();
    const user = await execute(() => getIdentity(client));
    if (!user) {
      bridge.clear();
      return errorResponse(unauthenticated());
    }
    const username = await claimUsername(user.id, input.username);
    return authJson({ user: { ...user, username } });
  }, true);
}
