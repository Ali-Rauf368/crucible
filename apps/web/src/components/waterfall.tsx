"use client";
import { useMemo, useState } from "react";
import { Bot, Wrench, Sparkles, Zap, AlertTriangle } from "lucide-react";
import { cx } from "./ui";
import { FAULT_COLORS } from "./domain";

export interface Span { spanId: string; traceId: string; parentSpanId: string | null; sessionId?: string | null; service?: string; name: string; kind: string; startTime: string; durationMs: number; status: string; attributes: Record<string, any>; events: { name: string; time: string; attributes?: Record<string, any> }[] } // eslint-disable-line @typescript-eslint/no-explicit-any
const KIND = { agent: { icon: Bot, bar: "bg-fg/25", text: "text-fg" }, llm: { icon: Sparkles, bar: "bg-accent", text: "text-accent" }, tool: { icon: Wrench, bar: "bg-info", text: "text-info" } } as const;

/** OTel trace waterfall: spans on a shared time axis, nested under the agent span, with fault markers. */
export function Waterfall({ spans }: { spans: Span[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const { rows, t0, total } = useMemo(() => {
    const sorted = [...spans].sort((a, b) => a.startTime.localeCompare(b.startTime));
    const t0 = sorted.length ? Date.parse(sorted[0].startTime) : 0;
    const end = Math.max(...sorted.map((s) => Date.parse(s.startTime) + s.durationMs), t0 + 1);
    const depth = (s: Span) => (s.parentSpanId && sorted.some((x) => x.spanId === s.parentSpanId) ? 1 : 0);
    return { rows: sorted.map((s) => ({ s, depth: depth(s) })), t0, total: end - t0 };
  }, [spans]);
  if (!spans.length) return <p className="text-sm text-muted">No spans recorded for this case.</p>;
  const selected = spans.find((s) => s.spanId === sel);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div>
      <div className="mb-1 flex text-[10px] text-subtle tabular-nums" aria-hidden>
        <div className="w-[38%] shrink-0 sm:w-[32%]" />
        <div className="relative h-4 flex-1">{ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: `${t * 100}%` }}>{fmtMs(total * t)}</span>)}</div>
      </div>
      <ul className="space-y-0.5" role="list">
        {rows.map(({ s, depth }) => {
          const k = KIND[s.kind as keyof typeof KIND] ?? KIND.tool;
          const Icon = k.icon;
          const left = ((Date.parse(s.startTime) - t0) / total) * 100;
          const width = Math.max(0.6, (s.durationMs / total) * 100);
          const fault = s.attributes["crucible.fault.type"] as string | undefined;
          const err = s.status === "error";
          return (
            <li key={s.spanId}>
              <button onClick={() => setSel(sel === s.spanId ? null : s.spanId)} className={cx("flex w-full items-center rounded-md py-1 text-left transition hover:bg-raised/70", sel === s.spanId && "bg-raised")}>
                <div className="flex w-[38%] shrink-0 items-center gap-1.5 truncate pr-2 text-xs sm:w-[32%]" style={{ paddingLeft: depth * 14 + 4 }}>
                  <Icon className={cx("h-3.5 w-3.5 shrink-0", err ? "text-bad" : k.text)} />
                  <span className={cx("truncate mono", err && "text-bad")}>{s.name}</span>
                  {fault && <Zap className="h-3 w-3 shrink-0" style={{ color: FAULT_COLORS[fault] }} aria-label={`fault ${fault}`} />}
                </div>
                <div className="grid-bg relative h-5 flex-1 rounded">
                  <div className={cx("absolute top-1 h-3 rounded-sm", err ? "bg-bad" : k.bar, s.kind === "agent" && "opacity-60")} style={{ left: `${left}%`, width: `${width}%` }} />
                  {fault && <div className="absolute top-0 h-5 w-0.5 rounded" style={{ left: `${left}%`, background: FAULT_COLORS[fault] }} />}
                  <span className="absolute top-0.5 text-[10px] tabular-nums text-muted" style={{ left: `min(calc(${left + width}% + 4px), calc(100% - 44px))` }}>{fmtMs(s.durationMs)}</span>
                </div>
              </button>
              {sel === s.spanId && selected && <SpanDetail s={selected} />}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-fg/25" />agent</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-accent" />LLM call</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-info" />tool call</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-bad" />error</span>
        <span className="flex items-center gap-1"><Zap className="h-3 w-3 text-warn" />fault injected</span>
      </div>
    </div>
  );
}

function SpanDetail({ s }: { s: Span }) {
  const a = s.attributes;
  const pick = (k: string) => a[k] !== undefined && a[k] !== null && a[k] !== "";
  const facts: [string, unknown][] = ([["status", s.status], ["duration", fmtMs(s.durationMs)], ["model", a["gen_ai.request.model"]], ["tool", a["gen_ai.tool.name"]], ["finish", a["gen_ai.response.finish_reasons"]], ["tokens in/out", pick("gen_ai.usage.input_tokens") ? `${a["gen_ai.usage.input_tokens"]} / ${a["gen_ai.usage.output_tokens"]}` : undefined], ["cost", pick("crucible.cost.usd") ? `$${Number(a["crucible.cost.usd"]).toFixed(5)}` : undefined], ["HTTP", a["http.response.status_code"]], ["call #", a["crucible.call.number"]], ["fault", a["crucible.fault.type"]]] as [string, unknown][]).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return (
    <div className="mx-1 mb-2 mt-1 animate-fadeIn rounded-lg border border-line bg-bg/60 p-3 text-xs">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">{facts.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-subtle">{k}</dt><dd className="truncate mono">{String(v)}</dd></div>)}</dl>
      {s.events.length > 0 && <ul className="mt-2 space-y-1">{s.events.map((e, i) => <li key={i} className="flex items-center gap-1.5 text-warn"><AlertTriangle className="h-3 w-3" /><span className="mono">{e.name}</span><span className="text-subtle">{JSON.stringify(e.attributes ?? {})}</span></li>)}</ul>}
      {pick("crucible.request.preview") && <Pre label="request (last message)" text={String(a["crucible.request.preview"])} />}
      {pick("crucible.tool.input") && <Pre label="tool input" text={String(a["crucible.tool.input"])} />}
      {pick("crucible.tool.output") && <Pre label="tool output" text={String(a["crucible.tool.output"])} />}
      <p className="mt-2 text-[10px] text-subtle mono">trace {s.traceId} · span {s.spanId}</p>
    </div>
  );
}
const Pre = ({ label, text }: { label: string; text: string }) => <div className="mt-2"><p className="mb-0.5 text-subtle">{label}</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-raised p-2 text-[11px] leading-4 mono">{text}</pre></div>;
export const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}s` : `${Math.round(v)}ms`);
