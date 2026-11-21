import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { pool, one } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed } from "../src/services/seed.js";
import { buildApp } from "../src/app.js";
import { registerJobs, setSelfUrl } from "../src/services/runner.js";
import { setPlatformSelfUrl } from "../src/routes/platform.js";
import { startWorker, stopWorker } from "../src/lib/queue.js";

export async function setup() {
  await migrate();
  await pool.query("TRUNCATE users, api_keys, agents, suites, scenarios, runs, run_cases, spans, audit_log, jobs RESTART IDENTITY CASCADE");
  await seed({ force: true });
  registerJobs();
  const app = buildApp();
  const server: Server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setSelfUrl(url); setPlatformSelfUrl(url);
  startWorker(8);
  const close = async () => { await stopWorker(); await new Promise((r) => server.close(() => r(null))); await pool.end(); };
  return { url, close };
}

export async function login(url: string, email = "engineer@crucible.dev") {
  const r = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "crucible-demo" }) });
  const { token } = await r.json();
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}
export const ids = async () => ({
  naive: (await one("SELECT id FROM agents WHERE slug = 'support-naive'")).id as number,
  hardened: (await one("SELECT id FROM agents WHERE slug = 'support-hardened'")).id as number,
  xl: (await one("SELECT id FROM agents WHERE slug = 'support-hardened-xl'")).id as number,
  resilience: (await one("SELECT id FROM suites WHERE slug = 'support-resilience'")).id as number,
  redteam: (await one("SELECT id FROM suites WHERE slug = 'redteam-injection'")).id as number,
  budgets: (await one("SELECT id FROM suites WHERE slug = 'cost-budgets'")).id as number,
});
