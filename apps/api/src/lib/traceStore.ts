import { MongoClient, type Collection } from "mongodb";
import { env } from "./env.js";
import { q } from "../db/pool.js";

/** OTel-shaped span as stored and served to the UI. */
export interface StoredSpan {
  spanId: string; traceId: string; parentSpanId: string | null; sessionId: string | null;
  name: string; kind: string; service: string; startTime: string; durationMs: number; status: "ok" | "error";
  attributes: Record<string, unknown>; events: { name: string; time: string; attributes?: Record<string, unknown> }[];
}

/**
 * Trace storage with two backends: MongoDB (document store for high-volume spans) when MONGO_URL is set,
 * otherwise PostgreSQL (`spans` table, JSONB attributes). Same interface either way.
 */
interface Store {
  backend: "mongodb" | "postgres";
  insert(spans: StoredSpan[]): Promise<void>;
  byTrace(traceId: string): Promise<StoredSpan[]>;
  bySession(sessionId: string): Promise<StoredSpan[]>;
  recent(opts: { limit: number; kind?: string; before?: string }): Promise<StoredSpan[]>;
  stats(sinceMinutes: number): Promise<{ bucket: string; calls: number; errors: number; faults: number; p95: number }[]>;
}

const fromRow = (r: Record<string, any>): StoredSpan => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
  spanId: r.span_id, traceId: r.trace_id, parentSpanId: r.parent_span_id, sessionId: r.session_id, name: r.name, kind: r.kind, service: r.service,
  startTime: new Date(r.start_time).toISOString(), durationMs: r.duration_ms, status: r.status, attributes: r.attributes, events: r.events,
});

const pgStore: Store = {
  backend: "postgres",
  async insert(spans) {
    if (!spans.length) return;
    const vals: unknown[] = [];
    const rows = spans.map((s, i) => {
      vals.push(s.spanId, s.traceId, s.parentSpanId, s.sessionId, s.name, s.kind, s.service, s.startTime, s.durationMs, s.status, JSON.stringify(s.attributes), JSON.stringify(s.events));
      const b = i * 12;
      return `(${Array.from({ length: 12 }, (_, k) => `$${b + k + 1}`).join(",")})`;
    });
    await q(`INSERT INTO spans (span_id, trace_id, parent_span_id, session_id, name, kind, service, start_time, duration_ms, status, attributes, events) VALUES ${rows.join(",")} ON CONFLICT (span_id) DO NOTHING`, vals);
  },
  byTrace: async (t) => (await q("SELECT * FROM spans WHERE trace_id = $1 ORDER BY start_time", [t])).map(fromRow),
  bySession: async (s) => (await q("SELECT * FROM spans WHERE session_id = $1 ORDER BY start_time", [s])).map(fromRow),
  recent: async ({ limit, kind, before }) => (await q(`SELECT * FROM spans WHERE ($2::text IS NULL OR kind = $2) AND ($3::timestamptz IS NULL OR start_time < $3) AND kind <> 'agent' ORDER BY start_time DESC LIMIT $1`, [limit, kind ?? null, before ?? null])).map(fromRow),
  stats: async (mins) => q(`SELECT to_char(date_trunc('minute', start_time), 'HH24:MI') AS bucket, count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors,
      count(*) FILTER (WHERE attributes ? 'crucible.fault.type')::int AS faults, COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::float AS p95
    FROM spans WHERE start_time > now() - ($1 || ' minutes')::interval AND kind IN ('llm','tool') GROUP BY 1, date_trunc('minute', start_time) ORDER BY date_trunc('minute', start_time)`, [String(mins)]),
};

let mongo: MongoClient | null = null, col: Collection<StoredSpan> | null = null;
const mongoStore: Store = {
  backend: "mongodb",
  async insert(spans) { if (spans.length) await col!.insertMany(spans.map((s) => ({ ...s })), { ordered: false }).catch((e) => { if (e?.code !== 11000) throw e; }); },
  byTrace: async (t) => col!.find({ traceId: t }, { projection: { _id: 0 } }).sort({ startTime: 1 }).toArray(),
  bySession: async (s) => col!.find({ sessionId: s }, { projection: { _id: 0 } }).sort({ startTime: 1 }).toArray(),
  recent: async ({ limit, kind, before }) => col!.find({ kind: kind ?? { $ne: "agent" }, ...(before ? { startTime: { $lt: before } } : {}) }, { projection: { _id: 0 } }).sort({ startTime: -1 }).limit(limit).toArray(),
  async stats(mins) {
    const since = new Date(Date.now() - mins * 60_000).toISOString();
    const rows = await col!.aggregate<{ _id: string; calls: number; errors: number; faults: number; durations: number[] }>([
      { $match: { startTime: { $gt: since }, kind: { $in: ["llm", "tool"] } } },
      { $group: { _id: { $substrCP: ["$startTime", 11, 5] }, calls: { $sum: 1 }, errors: { $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] } }, faults: { $sum: { $cond: [{ $ifNull: ["$attributes.crucible.fault.type", false] }, 1, 0] } }, durations: { $push: "$durationMs" } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    return rows.map((r) => { const d = r.durations.sort((a, b) => a - b); return { bucket: r._id, calls: r.calls, errors: r.errors, faults: r.faults, p95: d[Math.floor(d.length * 0.95)] ?? 0 }; });
  },
};

export let traces: Store = pgStore;
export async function initTraceStore() {
  if (!env.MONGO_URL) return traces;
  mongo = new MongoClient(env.MONGO_URL, { serverSelectionTimeoutMS: 4000 });
  await mongo.connect();
  col = mongo.db(env.MONGO_DB).collection<StoredSpan>("spans");
  await Promise.all([col.createIndex({ spanId: 1 }, { unique: true }), col.createIndex({ traceId: 1, startTime: 1 }), col.createIndex({ sessionId: 1, startTime: 1 }), col.createIndex({ startTime: -1 })]);
  traces = mongoStore;
  return traces;
}
export async function closeTraceStore() { await mongo?.close(); }
