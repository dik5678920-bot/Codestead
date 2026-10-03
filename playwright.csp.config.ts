import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "csp.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["dot"]],
  use: { baseURL: "http://localhost:3130", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node node_modules/next/dist/bin/next start --port 3130",
    url: "http://localhost:3130",
    timeout: 180_000,
    env: {
      APP_URL: "https://localhost:3130",
      AUTH_REQUIRED: "true",
      BETTER_AUTH_SECRET: "local-csp-verification-only-secret-32-bytes",
      LOST_DEVICE_PROOF_KEY: "local-csp-verification-only-proof-32-bytes",
      GOOGLE_CLIENT_ID: "csp-test.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "csp-test-only",
      ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
    },
  },
});
