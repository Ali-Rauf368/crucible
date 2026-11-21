"use client";
import { useEffect, useState } from "react";
import { Radio, Pause, Play, Sparkles, Wrench, Zap } from "lucide-react";
import { useApi } from "@/lib/api";
import { useLive } from "@/lib/live";
import { clock, usd } from "@/lib/format";
import { Card, CardHeader, PageHeader, Badge, Skeleton, Tabs, Empty, cx } from "@/components/ui";
import { Traffic } from "@/components/charts";
import { FAULT_COLORS } from "@/components/domain";
import { fmtMs, type Span } from "@/components/waterfall";

export default function TrafficPage() {
  const [kind, setKind] = useState<"all" | "llm" | "tool">("all");
  const t = useApi<{ spans: Span[]; stats: any[]; backend: string }>(`/api/traffic?limit=150${kind !== "all" ? `&kind=${kind}` : ""}`, { refreshMs: 15_000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [spans, setSpans] = useState<Span[]>([]);
  const [paused, setPaused] = useState(false);
  useEffect(() => { if (t.data) setSpans(t.data.spans); }, [t.data]);
  const state = useLive((e) => {
    if (paused || e.type !== "span") return;
    const s = e.span as Span;
    if (kind !== "all" && s.kind !== kind) return;
    setSpans((xs) => [s, ...xs.filter((x) => x.spanId !== s.spanId)].slice(0, 300));
  }, { traffic: true });

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Proxy" title="Live traffic" subtitle={`Every LLM and tool call through Crucible, streamed as OpenTelemetry spans. Stored in ${t.data?.backend === "mongodb" ? "MongoDB" : "PostgreSQL"}.`}
        actions={<><Badge tone={state === "live" ? "ok" : "warn"} dot>{state}</Badge><button className="btn-secondary" onClick={() => setPaused(!paused)}>{paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{paused ? "Resume" : "Pause"}</button></>} />
      <Card className="card-pad"><CardHeader title="Last 60 minutes" subtitle="Calls, injected faults, errors and p95 latency per minute" icon={Radio} />{t.data ? (t.data.stats.length ? <Traffic data={t.data.stats} height={220} /> : <Empty icon={Radio} title="No traffic in the last hour" message="Launch a run or use the chaos playground." />) : <Skeleton className="h-52" />}</Card>
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-line p-4"><Tabs value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "llm", label: "LLM" }, { value: "tool", label: "Tools" }]} /><span className="text-xs text-muted">{spans.length} spans</span></div>
        {!t.data ? <Skeleton className="m-4 h-64" /> : (
          <div className="max-h-[640px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel"><tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-subtle"><th className="px-4 py-2 font-medium">Time</th><th className="px-3 py-2 font-medium">Call</th><th className="hidden px-3 py-2 font-medium md:table-cell">Session</th><th className="px-3 py-2 font-medium">Fault</th><th className="px-3 py-2 text-right font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Duration</th><th className="hidden px-4 py-2 text-right font-medium lg:table-cell">Tokens · cost</th></tr></thead>
              <tbody>{spans.map((s) => {
                const a = s.attributes; const fault = a["crucible.fault.type"];
                return (
                  <tr key={s.spanId} className={cx("table-row animate-fadeIn", s.status === "error" && "bg-bad/5")}>
                    <td className="whitespace-nowrap px-4 py-2 text-xs tabular-nums text-muted">{clock(s.startTime)}</td>
                    <td className="px-3 py-2"><span className="flex items-center gap-1.5">{s.kind === "llm" ? <Sparkles className="h-3.5 w-3.5 text-accent" /> : <Wrench className="h-3.5 w-3.5 text-info" />}<span className="mono text-xs">{s.name}</span></span></td>
                    <td className="hidden px-3 py-2 md:table-cell">{s.sessionId ? <span className="mono text-[11px] text-subtle" title={`trace ${s.traceId}`}>{s.sessionId.slice(0, 14)}…</span> : <span className="text-[11px] text-subtle">{s.service ?? "—"}</span>}</td>
                    <td className="px-3 py-2">{fault ? <span className="inline-flex items-center gap-1 text-xs"><Zap className="h-3 w-3" style={{ color: FAULT_COLORS[fault] }} />{fault}</span> : <span className="text-xs text-subtle">—</span>}</td>
                    <td className={cx("px-3 py-2 text-right text-xs tabular-nums", s.status === "error" ? "text-bad" : "text-ok")}>{a["http.response.status_code"] ?? s.status}</td>
                    <td className={cx("px-3 py-2 text-right text-xs tabular-nums", s.durationMs > 3000 && "font-semibold text-warn")}>{fmtMs(s.durationMs)}</td>
                    <td className="hidden px-4 py-2 text-right text-xs tabular-nums text-muted lg:table-cell">{a["gen_ai.usage.input_tokens"] != null ? `${a["gen_ai.usage.input_tokens"]}/${a["gen_ai.usage.output_tokens"]} · ${usd(a["crucible.cost.usd"])}` : "—"}</td>
                  </tr>);
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
