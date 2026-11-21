import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { one } from "../db/pool.js";
import { env } from "../lib/env.js";
import { sign, requireRole, audit, COOKIE } from "../lib/auth.js";

export const authRouter = Router();
const DUMMY = bcrypt.hashSync("timing-equaliser", 10);

authRouter.post("/api/auth/login", rateLimit({ windowMs: 60_000, limit: Number(process.env.LOGIN_RATE_LIMIT ?? 20), standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const u = await one("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY);
  if (!u || !ok) return void res.status(401).json({ error: "unauthorized", message: "Invalid email or password" });
  const user = { id: u.id, email: u.email, name: u.name, role: u.role };
  const token = await sign(user);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", maxAge: 12 * 3600_000, path: "/" });
  await audit(u.email, "auth.login", null, {}, req.ip);
  res.json({ user, token });
});
authRouter.post("/api/auth/logout", (_req, res) => { res.clearCookie(COOKIE, { path: "/" }); res.json({ ok: true }); });
authRouter.get("/api/auth/me", requireRole("viewer"), (req, res) => { res.json({ user: req.user }); });
/** Short-lived ticket for the SSE stream (EventSource can't send headers). */
authRouter.get("/api/auth/stream-ticket", requireRole("viewer"), async (req, res) => { res.json({ ticket: await sign(req.user!, "2m", "stream") }); });
