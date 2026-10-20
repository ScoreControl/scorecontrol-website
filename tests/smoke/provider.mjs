// Test-only HTTP provider for exercising Next.js + the real Supabase SDK without cloud credentials.
import { createServer } from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";
const users = new Map();
const usernames = new Map();
const refreshTokens = new Map();
const accessTokens = new Map();
const recoveryTokens = new Map();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function issue(user, sessionId = randomUUID(), method = "password") {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, aud: "authenticated", role: "authenticated", session_id: sessionId, exp: expires, iat: expires - 3600, amr: [{ method, timestamp: expires - 3600 }] })}`;
  const access = `${payload}.${createHmac("sha256", "smoke-test-only").update(payload).digest("base64url")}`;
  const refresh = randomUUID();
  const result = { access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: 3600, expires_at: expires, user };
  accessTokens.set(access, { user, sessionId, expires });
  refreshTokens.set(refresh, { user, sessionId });
  return result;
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:54329");
  function send(value, status = 200) {
    // Real Supabase sends this; without it auth-js ignores error `code` values.
    response.writeHead(status, { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" });
    response.end(status === 204 ? undefined : JSON.stringify(value));
  }
  if (url.pathname === "/health") return send({ ready: true });
  // Test-only stand-in for reading the recovery email's {{ .TokenHash }}.
  if (url.pathname === "/test/recovery") return send([...recoveryTokens].find(([, email]) => email === url.searchParams.get("email"))?.[0] ?? null);
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {};
  const account = users.get(body.email);
  // Simulates the schema owner's PRIVATE, service-role-only mapping contract.
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    if (request.headers.apikey !== "sb_secret_smoke_test") return send({ code: "42501" }, 403);
    const name = body.requested_username;
    const id = body.account_id;
    if (url.pathname.endsWith("/auth_resolve_username")) {
      const owner = usernames.get(name);
      return send(owner ? [{ user_id: owner.id, email: owner.email }] : []);
    }
    if (url.pathname.endsWith("/auth_username_for_user")) return send([...usernames].find(([, user]) => user.id === id)?.[0] ?? null);
    if (url.pathname.endsWith("/auth_claim_username")) {
      const existing = [...usernames].find(([, user]) => user.id === id)?.[0];
      if (existing) return send(existing);
      if (usernames.has(name)) return send({ code: "23505" }, 409);
      const user = [...users.values()].find(({ user }) => user.id === id)?.user;
      if (!user) return send({ code: "23503" }, 400);
      usernames.set(name, user);
      return send(name);
    }
    return send({ code: "PGRST202" }, 404);
  }
  if (url.pathname === "/auth/v1/signup") {
    if (account) return send({ code: "user_already_exists", msg: "Already registered" }, 400);
    const name = body.data?.scorecontrol_username;
    if (name && usernames.has(name)) return send({ code: "unexpected_failure" }, 500);
    const user = { id: randomUUID(), email: body.email, aud: "authenticated", role: "authenticated", email_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(), app_metadata: { provider: "email" }, user_metadata: body.data ?? {} };
    if (name) usernames.set(name, user);
    users.set(body.email, { user, password: hash(body.password) });
    return send(issue(user));
  }
  if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
    if (!account || account.password !== hash(body.password)) return send({ code: "invalid_credentials", msg: "Invalid credentials" }, 400);
    return send(issue(account.user));
  }
  if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
    const token = refreshTokens.get(body.refresh_token);
    if (!token) return send({ code: "refresh_token_not_found", msg: "Invalid refresh token" }, 400);
    return send(issue(token.user, token.sessionId));
  }
  const token = accessTokens.get(request.headers.authorization?.replace("Bearer ", ""));
  if (url.pathname === "/auth/v1/user") {
    if (!token || token.expires <= Date.now() / 1000) return send({ code: "bad_jwt", msg: "Invalid token" }, 401);
    if (request.method === "PUT" && body.password) {
      const stored = users.get(token.user.email);
      if (stored.password === hash(body.password)) return send({ code: "same_password", msg: "Same password" }, 422);
      stored.password = hash(body.password);
    }
    return send(token.user);
  }
  if (url.pathname === "/auth/v1/logout") {
    // Like Supabase, revoked sessions also stop validating their access tokens at /user.
    const others = url.searchParams.get("scope") === "others";
    const revoke = (sessionId) => others ? sessionId !== token.sessionId : sessionId === token.sessionId;
    if (token) {
      for (const [key, value] of refreshTokens) if (value.user.id === token.user.id && revoke(value.sessionId)) refreshTokens.delete(key);
      for (const [key, value] of accessTokens) if (value.user.id === token.user.id && revoke(value.sessionId)) accessTokens.delete(key);
    }
    return send(null, 204);
  }
  if (url.pathname === "/auth/v1/resend") return send({});
  if (url.pathname === "/auth/v1/recover") {
    if (account) recoveryTokens.set(randomUUID().replaceAll("-", ""), body.email);
    return send({});
  }
  if (url.pathname === "/auth/v1/verify") {
    const email = recoveryTokens.get(body.token_hash);
    if (body.type !== "recovery" || !email) return send({ code: "otp_expired", msg: "Expired" }, 403);
    recoveryTokens.delete(body.token_hash);
    return send(issue(users.get(email).user, randomUUID(), "otp"));
  }
  return send({ code: "not_found", msg: "Not found" }, 404);
});
server.listen(54329, "127.0.0.1", () => process.stdout.write("Auth smoke provider ready.\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
