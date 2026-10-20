import { defineConfig } from "@playwright/test";
import { config } from "dotenv";
config({ path: ".env.test.local", quiet: true });
const url = process.env.AUTH_TEST_SUPABASE_URL ?? "http://127.0.0.1:54321";
const parsed = new URL(url);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.protocol !== "http:") {
  throw new Error("Auth integration tests may only create accounts on a local HTTP Supabase service.");
}
const key = process.env.AUTH_TEST_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.AUTH_TEST_SUPABASE_SECRET_KEY?.trim();
if (!key || !secretKey) {
  throw new Error("Set AUTH_TEST_SUPABASE_PUBLISHABLE_KEY and AUTH_TEST_SUPABASE_SECRET_KEY in ignored .env.test.local from `npx supabase status`. See docs/ENVIRONMENT.md.");
}

export default defineConfig({
  testDir: "./tests/integration/auth",
  fullyParallel: false, workers: 1, timeout: 60000,
  use: { baseURL: "http://localhost:3000", browserName: "chromium" },
  webServer: { command: "npm run dev -- --port 3000", url: "http://localhost:3000", reuseExistingServer: false, timeout: 120000,
    env: { APP_ORIGIN: "http://localhost:3000", NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
      UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", AUTH_TRUSTED_IP_HEADER: "", SUPABASE_SECRET_KEY: secretKey } },
});
