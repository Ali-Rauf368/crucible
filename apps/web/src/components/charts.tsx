"use client";
import { ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, PieChart, Pie, Cell, ComposedChart } from "recharts";

export const COLORS = ["#fb923c", "#60a5fa", "#34d399", "#f472b6", "#facc15", "#a78bfa", "#2dd4bf", "#f87171"];
const axis = { fill: "rgb(var(--subtle))", fontSize: 11 };
export const tooltip = { contentStyle: { background: "rgb(var(--panel))", border: "1px solid rgb(var(--line))", borderRadius: 10, fontSize: 12, color: "rgb(var(--fg))", boxShadow: "0 8px 24px -12px rgba(0,0,0,.5)" }, labelStyle: { color: "rgb(var(--muted))" }, itemStyle: { padding: 0 } };
const pctFmt = (v: number) => `${Math.round(v * 100)}%`;

export function Lines({ data, series, height = 240, percent = true, x = "t" }: { data: Record<string, unknown>[]; series: { key: string; label: string; color?: string }[]; height?: number; percent?: boolean; x?: string }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="rgb(var(--line))" strokeDasharray="3 3" />
          <XAxis dataKey={x} tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={44} domain={percent ? [0, 1] : ["auto", "auto"]} tickFormatter={percent ? pctFmt : undefined} />
          <Tooltip {...tooltip} formatter={(v: number, n: string) => [percent ? pctFmt(v) : v, n]} />
          {series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? COLORS[i]} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />)}
          {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RadarScores({ series, height = 260 }: { series: { label: string; color?: string; scores: Record<string, number> }[]; height?: number }) {
  const dims = ["accuracy", "safety", "resilience", "passRate"];
  const names: Record<string, string> = { accuracy: "Accuracy", safety: "Safety", resilience: "Resilience", passRate: "Pass rate" };
  const data = dims.map((d) => Object.fromEntries([["dim", names[d]], ...series.map((s) => [s.label, s.scores[d] ?? 0])]));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke="rgb(var(--line))" />
          <PolarAngleAxis dataKey="dim" tick={{ ...axis, fill: "rgb(var(--muted))" }} />
          <PolarRadiusAxis domain={[0, 1]} tick={false} axisLine={false} />
          {series.map((s, i) => <Radar key={s.label} name={s.label} dataKey={s.label} stroke={s.color ?? COLORS[i]} fill={s.color ?? COLORS[i]} fillOpacity={0.16} strokeWidth={2} isAnimationActive={false} />)}
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
          <Tooltip {...tooltip} formatter={(v: number) => pctFmt(v)} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal bars: survival rate per fault type with injection volume. */
export function FaultSurvival({ data, height }: { data: { type: string; cases: number; survived: number; color: string }[]; height?: number }) {
  const rows = data.map((d) => ({ ...d, rate: d.cases ? d.survived / d.cases : 0 }));
  return (
    <div style={{ height: height ?? Math.max(140, rows.length * 34) }} className="w-full">
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid horizontal={false} stroke="rgb(var(--line))" strokeDasharray="3 3" />
          <XAxis type="number" domain={[0, 1]} tickFormatter={pctFmt} tick={axis} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="type" tick={{ ...axis, fill: "rgb(var(--muted))" }} width={110} tickLine={false} axisLine={false} />
          <Tooltip {...tooltip} cursor={{ fill: "rgb(var(--raised))" }} formatter={(_v, _n, p) => [`${p.payload.survived}/${p.payload.cases} cases passed`, "Survival"]} />
          <Bar dataKey="rate" radius={[0, 4, 4, 0]} barSize={14} isAnimationActive={false}>{rows.map((r) => <Cell key={r.type} fill={r.color} />)}</Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Donut({ data, height = 180, center }: { data: { name: string; value: number; color: string }[]; height?: number; center?: React.ReactNode }) {
  return (
    <div style={{ height }} className="relative w-full">
      <ResponsiveContainer>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="90%" paddingAngle={2} stroke="none" isAnimationActive={false}>{data.map((d) => <Cell key={d.name} fill={d.color} />)}</Pie>
          <Tooltip {...tooltip} />
        </PieChart>
      </ResponsiveContainer>
      {center && <div className="pointer-events-none absolute inset-0 flex items-center justify-center">{center}</div>}
    </div>
  );
}

export function Traffic({ data, height = 200 }: { data: { bucket: string; calls: number; errors: number; faults: number; p95: number }[]; height?: number }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 0, left: -12, bottom: 0 }}>
          <defs><linearGradient id="tr" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#fb923c" stopOpacity={0.35} /><stop offset="100%" stopColor="#fb923c" stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="rgb(var(--line))" strokeDasharray="3 3" />
          <XAxis dataKey="bucket" tick={axis} tickLine={false} axisLine={false} minTickGap={30} />
          <YAxis yAxisId="l" tick={axis} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
          <YAxis yAxisId="r" orientation="right" tick={axis} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `${Math.round(v)}ms`} />
          <Tooltip {...tooltip} />
          <Area yAxisId="l" type="monotone" dataKey="calls" name="Calls" stroke="#fb923c" fill="url(#tr)" strokeWidth={1.8} isAnimationActive={false} />
          <Bar yAxisId="l" dataKey="faults" name="Faults injected" fill="#a78bfa" barSize={6} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Bar yAxisId="l" dataKey="errors" name="Errors" fill="#f87171" barSize={6} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="r" type="monotone" dataKey="p95" name="p95 latency" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function GroupedBars({ data, keys, height = 220, percent }: { data: Record<string, unknown>[]; keys: { key: string; label: string; color?: string }[]; height?: number; percent?: boolean }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="rgb(var(--line))" strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={44} domain={percent ? [0, 1] : undefined} tickFormatter={percent ? pctFmt : undefined} />
          <Tooltip {...tooltip} cursor={{ fill: "rgb(var(--raised))" }} formatter={(v: number, n: string) => [percent ? pctFmt(v) : v, n]} />
          {keys.map((k, i) => <Bar key={k.key} dataKey={k.key} name={k.label} fill={k.color ?? COLORS[i]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />)}
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
