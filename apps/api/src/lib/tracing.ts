import { trace, context, SpanKind, SpanStatusCode, type Span, type Context } from "@opentelemetry/api";
import { BasicTracerProvider, type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { traces, type StoredSpan } from "./traceStore.js";
import { publish } from "./bus.js";

/**
 * OpenTelemetry tracing. Every proxied LLM/tool call and every agent run is a real OTel span
 * (gen_ai.* semantic conventions + crucible.* attributes). Spans are exported to the trace store and
 * broadcast to the live traffic view. External agents can also send their own spans via OTLP/HTTP JSON.
 */
const hr = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;

export function toStored(s: ReadableSpan): StoredSpan {
  const a = s.attributes as Record<string, unknown>;
  return {
    spanId: s.spanContext().spanId, traceId: s.spanContext().traceId, parentSpanId: s.parentSpanContext?.spanId ?? null,
    sessionId: (a["crucible.session.id"] as string) ?? null, name: s.name, kind: (a["crucible.span.kind"] as string) ?? "internal",
    service: String(s.resource.attributes[ATTR_SERVICE_NAME] ?? "crucible"), startTime: new Date(hr(s.startTime)).toISOString(),
    durationMs: Math.round(hr(s.duration) * 100) / 100, status: s.status.code === SpanStatusCode.ERROR ? "error" : "ok", attributes: a,
    events: s.events.map((e) => ({ name: e.name, time: new Date(hr(e.time)).toISOString(), attributes: e.attributes as Record<string, unknown> })),
  };
}

/** Exporter → trace store (Postgres or MongoDB). Exported synchronously per span so results are queryable immediately. */
class StoreExporter implements SpanExporter {
  async export(spans: ReadableSpan[], done: (r: { code: number; error?: Error }) => void) {
    try {
      const stored = spans.map(toStored);
      await traces.insert(stored);
      for (const s of stored) if (s.kind === "llm" || s.kind === "tool") publish({ type: "span", span: { ...s, events: undefined } }).catch(() => {});
      done({ code: 0 });
    } catch (e) { console.error("span export failed:", (e as Error).message); done({ code: 1, error: e as Error }); }
  }
  async shutdown() {}
}

const pending = new Set<Promise<unknown>>();
class ImmediateProcessor implements SpanProcessor {
  constructor(private exporter: SpanExporter) {}
  onStart() {}
  onEnd(span: ReadableSpan) {
    const p = new Promise((res) => this.exporter.export([span], res));
    pending.add(p); p.finally(() => pending.delete(p));
  }
  async forceFlush() { await Promise.all([...pending]); }
  async shutdown() { await this.forceFlush(); }
}

const provider = new BasicTracerProvider({ resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "crucible" }), spanProcessors: [new ImmediateProcessor(new StoreExporter())] });
export const tracer = provider.getTracer("crucible", "1.0.0");
export const flushSpans = () => provider.forceFlush();

/** Rebuilds a parent context from stored ids (e.g. proxy call belonging to a run case in another process). */
export function remoteParent(traceId: string, spanId: string): Context {
  return trace.setSpanContext(context.active(), { traceId, spanId, traceFlags: 1, isRemote: true });
}
export function startSpan(name: string, attrs: Record<string, string | number | boolean | undefined>, parent?: Context, kind: SpanKind = SpanKind.CLIENT): Span {
  const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
  return tracer.startSpan(name, { kind, attributes: clean }, parent ?? context.active());
}
export { SpanStatusCode, SpanKind };

/** OTLP/HTTP JSON (ExportTraceServiceRequest) → stored spans. */
export function fromOtlp(body: any): StoredSpan[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: StoredSpan[] = [];
  const val = (v: any): unknown => v == null ? null : v.stringValue ?? (v.intValue != null ? Number(v.intValue) : undefined) ?? v.doubleValue ?? v.boolValue ?? (v.arrayValue ? (v.arrayValue.values ?? []).map(val) : JSON.stringify(v)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const attrs = (list: any[] = []) => Object.fromEntries(list.map((kv) => [kv.key, val(kv.value)])); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const rs of body?.resourceSpans ?? []) {
    const res = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) for (const s of ss.spans ?? []) {
      const a = attrs(s.attributes);
      const start = Number(BigInt(s.startTimeUnixNano ?? 0) / 1_000_000n), end = Number(BigInt(s.endTimeUnixNano ?? s.startTimeUnixNano ?? 0) / 1_000_000n);
      out.push({
        spanId: String(s.spanId), traceId: String(s.traceId), parentSpanId: s.parentSpanId || null, sessionId: (a["crucible.session.id"] as string) ?? null,
        name: String(s.name ?? "span"), kind: (a["crucible.span.kind"] as string) ?? (a["gen_ai.operation.name"] ? "llm" : "external"), service: String(res["service.name"] ?? "external"),
        startTime: new Date(start).toISOString(), durationMs: Math.max(0, end - start), status: s.status?.code === 2 ? "error" : "ok", attributes: a,
        events: (s.events ?? []).map((e: any) => ({ name: e.name, time: new Date(Number(BigInt(e.timeUnixNano ?? 0) / 1_000_000n)).toISOString(), attributes: attrs(e.attributes) })), // eslint-disable-line @typescript-eslint/no-explicit-any
      });
    }
  }
  return out;
}
