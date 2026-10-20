import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/smoke",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: { baseURL: "http://localhost:3100", browserName: "chromium" },
  webServer: [
    { command: "node tests/smoke/provider.mjs", url: "http://127.0.0.1:54329/health", reuseExistingServer: false },
    { command: "npm run dev -- --port 3100", url: "http://localhost:3100", reuseExistingServer: false, timeout: 120000,
      env: {
        APP_ORIGIN: "http://localhost:3100", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54329",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_smoke_test", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "",
        AUTH_TRUSTED_IP_HEADER: "", SUPABASE_SECRET_KEY: "sb_secret_smoke_test",
      } },
  ],
});
