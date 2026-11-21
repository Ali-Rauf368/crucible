import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4200),
  DATABASE_URL: z.string().default("postgresql://crucible@127.0.0.1:55435/crucible"),
  REDIS_URL: z.string().optional(),
  MONGO_URL: z.string().optional(),
  MONGO_DB: z.string().default("crucible"),
  JWT_SECRET: z.string().min(16).default("dev-only-secret-change-me-please"),
  WEB_ORIGIN: z.string().default("http://localhost:3200"),
  PUBLIC_URL: z.string().default("http://127.0.0.1:4200"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  JUDGE_MODE: z.enum(["auto", "claude", "heuristic"]).default("auto"),
  CI_TOKEN: z.string().optional(),
  SEED: z.enum(["on", "off"]).default("on"),
  LOG_LEVEL: z.string().default("info"),
});
export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
