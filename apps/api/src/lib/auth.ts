import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { env } from "./env.js";
import { one, q } from "../db/pool.js";

export type Role = "viewer" | "engineer" | "admin";
export interface SessionUser { id: number; email: string; name: string; role: Role }
declare global { namespace Express { interface Request { user?: SessionUser; apiKey?: { id: number; name: string; scopes: string[] } } } } // eslint-disable-line @typescript-eslint/no-namespace

const secret = new TextEncoder().encode(env.JWT_SECRET);
const RANK: Record<Role, number> = { viewer: 0, engineer: 1, admin: 2 };
export const COOKIE = "crucible_session";

export const sign = (u: SessionUser, ttl = "12h", purpose = "session") =>
  new SignJWT({ ...u, purpose }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(ttl).sign(secret);
export async function verify(token: string, purpose = "session"): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.purpose !== purpose) return null;
    return { id: payload.id as number, email: payload.email as string, name: payload.name as string, role: payload.role as Role };
  } catch { return null; }
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Session (cookie or Bearer JWT) with a minimum role. */
export const requireRole = (role: Role) => async (req: Request, res: Response, next: NextFunction) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const user = await verify(req.cookies?.[COOKIE] ?? bearer ?? "");
  if (!user) return res.status(401).json({ error: "unauthorized", message: "Sign in required" });
  if (RANK[user.role] < RANK[role]) return res.status(403).json({ error: "forbidden", message: `Requires ${role} role` });
  req.user = user;
  next();
};

/** API key (x-api-key or Bearer cr_…) with a scope; CI_TOKEN env is accepted for bootstrap. */
export type Scope = "proxy" | "ci" | "ingest";
/** Resolves a raw API key: the key row, null (invalid) or "forbidden" (valid but missing the scope). */
export async function checkKey(raw: string | undefined, scope: Scope) {
  if (!raw) return null;
  if (env.CI_TOKEN && safeEqual(raw, env.CI_TOKEN)) return { id: 0, name: "CI_TOKEN", scopes: ["proxy", "ci", "ingest"] };
  const key = await one("SELECT id, name, scopes FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL", [sha256(raw)]);
  if (!key) return null;
  if (!key.scopes.includes(scope)) return "forbidden" as const;
  q("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [key.id]).catch(() => {});
  return key as { id: number; name: string; scopes: string[] };
}
export const requireKey = (scope: Scope, header = "x-api-key") => async (req: Request, res: Response, next: NextFunction) => {
  const raw = (req.headers[header] as string | undefined) ?? (req.headers.authorization?.startsWith("Bearer cr_") ? req.headers.authorization.slice(7) : undefined);
  const key = await checkKey(raw, scope);
  if (!key) return res.status(401).json({ error: "unauthorized", message: `Valid API key required (${header})` });
  if (key === "forbidden") return res.status(403).json({ error: "forbidden", message: `Key lacks scope ${scope}` });
  req.apiKey = key;
  next();
};

export async function createApiKey(name: string, userId: number | null, scopes = ["proxy", "ci", "ingest"]) {
  const key = `cr_${crypto.randomBytes(24).toString("base64url")}`;
  const row = await one("INSERT INTO api_keys (name, key_hash, preview, scopes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, preview, scopes, created_at", [name, sha256(key), `${key.slice(0, 7)}…${key.slice(-4)}`, scopes, userId]);
  return { ...row, key };
}

export async function audit(actor: string, action: string, target: string | null, data: Record<string, unknown> = {}, ip?: string) {
  await q("INSERT INTO audit_log (actor, action, target, data, ip) VALUES ($1,$2,$3,$4,$5)", [actor, action, target, JSON.stringify(data), ip ?? null]);
}
