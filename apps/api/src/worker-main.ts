// Standalone worker: npm run worker (scale horizontally; run API instances with WORKER=off)
import { migrate } from "./db/migrate.js";
import { startBusListener } from "./lib/bus.js";
import { startWorker, queueBackend } from "./lib/queue.js";
import { initTraceStore } from "./lib/traceStore.js";
import { registerJobs } from "./services/runner.js";

await migrate();
await initTraceStore();
await startBusListener();
registerJobs();
startWorker(Number(process.env.WORKER_CONCURRENCY ?? 8));
console.log(`Crucible worker started (queue=${queueBackend()}); proxy at ${process.env.PUBLIC_URL ?? "http://127.0.0.1:4200"}`);
