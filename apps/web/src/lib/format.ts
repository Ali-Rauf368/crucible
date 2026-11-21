export const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
export const ms = (v: number | null | undefined) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
export const num = (v: number | null | undefined) => (v == null ? "—" : Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: v > 9999 ? "compact" : "standard" }).format(v));
export const minutes = (m: number | null | undefined) => (m == null ? "—" : m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`);

export function ago(d: string | Date | null | undefined, now = Date.now()) {
  if (!d) return "—";
  const s = Math.round((now - new Date(d).getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const clock = (d: string | Date) => new Date(d).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const hm = (d: string | Date) => new Date(d).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const dateTime = (d: string | Date) => new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const duration = (from: string | Date, to?: string | Date | null) => minutes((new Date(to ?? Date.now()).getTime() - new Date(from).getTime()) / 60000);
export const short = (sha: string) => sha.slice(0, 7);
export const usd = (v: number | null | undefined) => (v == null ? "—" : v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const score = (v: number | null | undefined) => (v == null ? "—" : (v * 100).toFixed(0));
export const signed = (v: number, digits = 1, suffix = "") => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}${suffix}`;
