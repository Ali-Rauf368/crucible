import { env } from "./lib/env.js";
import { buildApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { pool, one } from "./db/pool.js";
import { seed } from "./services/seed.js";
import { startBusListener, stopBusListener } from "./lib/bus.js";
import { startWorker, stopWorker, queueBackend } from "./lib/queue.js";
import { initTraceStore, closeTraceStore } from "./lib/traceStore.js";
import { registerJobs, createRun, setSelfUrl } from "./services/runner.js";
import { setPlatformSelfUrl } from "./routes/platform.js";
import { judgeMode } from "./eval/judge.js";
import { flushSpans } from "./lib/tracing.js";

await migrate();
const store = await initTraceStore();
const seeded = env.SEED === "on" && (await seed());
await startBusListener();
registerJobs();

const app = buildApp();
const host = process.env.HOST ?? "127.0.0.1";
const server = app.listen(env.PORT, host, () => {
  const self = `http://127.0.0.1:${env.PORT}`;
  setSelfUrl(process.env.PUBLIC_URL ?? self); setPlatformSelfUrl(process.env.PUBLIC_URL ?? self);
  console.log(`Crucible API on :${env.PORT} · traces=${store.backend} · queue=${queueBackend()} · judge=${judgeMode()}`);
  if (process.env.WORKER !== "off") startWorker(Number(process.env.WORKER_CONCURRENCY ?? 6));
  if (seeded) void bootstrapRuns();
});
server.requestTimeout = 0; // long-poll CI waits and hanging-upstream simulations

/** First boot: produce real history (baselines + the fragile v1) so dashboards aren't empty. */
async function bootstrapRuns() {
  const agent = async (slug: string) => (await one("SELECT id FROM agents WHERE slug = $1", [slug])).id;
  const suite = async (slug: string) => (await one("SELECT id FROM suites WHERE slug = $1", [slug])).id;
  const seed = 424242;
  for (const s of ["support-resilience", "redteam-injection", "cost-budgets"]) {
    await createRun({ suiteId: await suite(s), agentId: await agent("support-hardened"), label: "v2.0 baseline", seed, baseline: true, createdBy: "bootstrap" });
    await createRun({ suiteId: await suite(s), agentId: await agent("support-naive"), label: "v1.4 (legacy)", seed, createdBy: "bootstrap" });
  }
  await createRun({ suiteId: await suite("cost-budgets"), agentId: await agent("support-hardened-xl"), label: "v2.1-rc · XL model", seed, createdBy: "bootstrap" });
  console.log("bootstrap: queued demo runs (hardened baseline, legacy v1, XL candidate)");
}

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close();
    await stopWorker();
    await flushSpans().catch(() => {});
    await stopBusListener();
    await closeTraceStore();
    await pool.end();
    process.exit(0);
  });
