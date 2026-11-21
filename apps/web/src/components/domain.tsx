"use client";
import { ShieldAlert, RotateCcw, Repeat, Bomb, Timer, CheckCircle2, AlertTriangle, XCircle, Activity, Gauge } from "lucide-react";
import { Badge, cx, type Tone } from "./ui";

export const OUTCOMES: Record<string, { label: string; tone: Tone; icon: typeof Activity; color: string; help: string }> = {
  ok: { label: "OK", tone: "ok", icon: CheckCircle2, color: "#34d399", help: "Correct, no faults injected" },
  recovered: { label: "Recovered", tone: "ok", icon: RotateCcw, color: "#2dd4bf", help: "Faults injected; still correct" },
  degraded: { label: "Degraded", tone: "warn", icon: AlertTriangle, color: "#facc15", help: "Faults injected; degraded but stayed up" },
  incorrect: { label: "Incorrect", tone: "warn", icon: XCircle, color: "#fb923c", help: "Wrong answer without faults" },
  over_budget: { label: "Over budget", tone: "warn", icon: Gauge, color: "#f59e0b", help: "Correct but exceeded a cost, token, latency or call budget" },
  crashed: { label: "Crashed", tone: "bad", icon: Bomb, color: "#f87171", help: "Agent threw an error" },
  timeout: { label: "Timeout", tone: "bad", icon: Timer, color: "#e879f9", help: "Exceeded the case time limit" },
  loop: { label: "Loop", tone: "bad", icon: Repeat, color: "#c084fc", help: "Runaway retries / call budget exceeded" },
  unsafe: { label: "Unsafe", tone: "bad", icon: ShieldAlert, color: "#ef4444", help: "Dangerous action or secret leak" },
};
export function OutcomeBadge({ o }: { o: string | null }) {
  const x = o ? OUTCOMES[o] : null;
  if (!x) return <Badge>pending</Badge>;
  const Icon = x.icon;
  return <Badge tone={x.tone} className="gap-1"><Icon className="h-3 w-3" />{x.label}</Badge>;
}
const RUN: Record<string, Tone> = { queued: "neutral", running: "info", completed: "ok", failed: "bad", cancelled: "neutral" };
export function RunStatus({ s, done, total }: { s: string; done?: number; total?: number }) {
  return <Badge tone={RUN[s] ?? "neutral"} dot>{s}{s === "running" && total ? ` ${done}/${total}` : ""}</Badge>;
}
export const FAULT_COLORS: Record<string, string> = { http_error: "#f87171", rate_limit: "#fb923c", latency: "#facc15", timeout: "#e879f9", malformed_json: "#60a5fa", schema_drift: "#38bdf8", empty_response: "#94a3b8", truncated: "#a78bfa", prompt_injection: "#ef4444" };
export function FaultChip({ type, target }: { type: string; target?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-1.5 py-0.5 text-[10.5px] mono" title={target}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: FAULT_COLORS[type] ?? "#999" }} />{type}{target ? <span className="text-subtle">@{target.replace("tool:", "")}</span> : null}
    </span>
  );
}

/** Radial score gauge (0..1). */
export function ScoreRing({ value, label, size = 92, sub }: { value: number | null | undefined; label: string; size?: number; sub?: string }) {
  const v = value ?? 0, r = size / 2 - 7, c = 2 * Math.PI * r;
  const color = value == null ? "rgb(var(--line))" : v >= 0.85 ? "rgb(var(--ok))" : v >= 0.7 ? "rgb(var(--warn))" : "rgb(var(--bad))";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" role="img" aria-label={`${label} ${Math.round(v * 100)}`}>
          <circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(var(--raised))" strokeWidth={7} fill="none" />
          <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={7} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v)} style={{ transition: "stroke-dashoffset .8s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-xl font-semibold tabular-nums">{value == null ? "—" : Math.round(v * 100)}</span></div>
      </div>
      <div className="text-center"><p className="text-xs font-medium">{label}</p>{sub && <p className="text-[10px] text-subtle">{sub}</p>}</div>
    </div>
  );
}

export function Delta({ v, invert, digits = 1, suffix = "", scale = 100 }: { v: number | null | undefined; invert?: boolean; digits?: number; suffix?: string; scale?: number }) {
  if (v == null || Number.isNaN(v)) return <span className="text-subtle">—</span>;
  const good = invert ? v < 0 : v > 0;
  const x = v * scale;
  return <span className={cx("tabular-nums font-medium", Math.abs(x) < 0.05 ? "text-subtle" : good ? "text-ok" : "text-bad")}>{x > 0 ? "+" : x < 0 ? "−" : "±"}{Math.abs(x).toFixed(digits)}{suffix}</span>;
}

/** Segmented bar of outcome counts. */
export function OutcomeBar({ outcomes, className }: { outcomes: Record<string, number> | undefined; className?: string }) {
  const entries = Object.entries(outcomes ?? {}).filter(([, n]) => n > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (!total) return <div className={cx("h-2 rounded-full bg-raised", className)} />;
  const order = Object.keys(OUTCOMES);
  entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return (
    <div className={cx("flex h-2 overflow-hidden rounded-full bg-raised", className)} role="img" aria-label={entries.map(([k, n]) => `${n} ${k}`).join(", ")}>
      {entries.map(([k, n]) => <div key={k} title={`${OUTCOMES[k]?.label ?? k}: ${n}`} style={{ width: `${(n / total) * 100}%`, background: OUTCOMES[k]?.color ?? "#888" }} />)}
    </div>
  );
}
