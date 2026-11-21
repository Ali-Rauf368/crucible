import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    env: { NODE_ENV: "test", DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://crucible@127.0.0.1:55435/crucible_test", JUDGE_MODE: "heuristic", SEED: "off", CI_TOKEN: "", LOGIN_RATE_LIMIT: "1000", CASE_TIMEOUT_MS: "25000" },
    fileParallelism: false, testTimeout: 180_000, hookTimeout: 60_000,
  },
});
