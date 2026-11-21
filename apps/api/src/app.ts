import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { env } from "./lib/env.js";
import { authRouter } from "./routes/auth.js";
import { coreRouter } from "./routes/core.js";
import { platformRouter } from "./routes/platform.js";
import { proxyRouter } from "./proxy/router.js";

export function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(cors({ origin: env.WEB_ORIGIN.split(","), credentials: true }));
  app.use(cookieParser());
  // keep raw text for NDJSON ingest; JSON elsewhere
  app.use("/api/ingest/nifi", express.text({ type: ["application/x-ndjson", "text/plain"], limit: "20mb" }), (req, _res, next) => { if (typeof req.body === "string") { (req as Request & { rawBody?: string }).rawBody = req.body; req.body = undefined; } next(); });
  app.use(express.json({ limit: "20mb" }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: Number(process.env.API_RATE_LIMIT ?? 3000), standardHeaders: true, legacyHeaders: false }));
  app.use((req, res, next) => {
    const t0 = performance.now();
    res.on("finish", () => { const ms = performance.now() - t0; if (env.NODE_ENV !== "test" && !req.path.startsWith("/proxy") && (res.statusCode >= 500 || (ms > 2000 && !req.path.startsWith("/proxy") && req.path !== "/api/stream" && !req.path.startsWith("/api/ci")))) console.log(JSON.stringify({ level: "info", method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) })); });
    next();
  });
  app.use(authRouter, coreRouter, platformRouter, proxyRouter);
  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => { // eslint-disable-line @typescript-eslint/no-unused-vars
    if (err instanceof ZodError) return void res.status(400).json({ error: "validation_error", message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    if (err instanceof SyntaxError || err.type === "entity.parse.failed") return void res.status(400).json({ error: "bad_request", message: "Malformed JSON body" });
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "internal_error" : "request_error", message: status >= 500 && env.NODE_ENV === "production" ? "Internal error" : err.message });
  });
  return app;
}
