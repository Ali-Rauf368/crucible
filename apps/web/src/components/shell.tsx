"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { LayoutDashboard, PlayCircle, FlaskConical, GitCompareArrows, Zap, Radio, Bot, Plug, ShieldCheck, Menu, X, Sun, Moon, LogOut, Rocket } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { useLive, type LiveEvent, type LiveState } from "@/lib/live";
import { Modal, Spinner, ToastProvider, useToast, cx } from "./ui";

export interface User { id: number; name: string; email: string; role: "viewer" | "engineer" | "admin" }
const RANK = ["viewer", "engineer", "admin"];
const SessionCtx = createContext<User | null>(null);
export const useSession = () => useContext(SessionCtx);
export const can = (u: User | null, role: User["role"]) => !!u && RANK.indexOf(u.role) >= RANK.indexOf(role);

type Listener = (e: LiveEvent) => void;
const LiveCtx = createContext<{ state: LiveState; subscribe: (l: Listener) => () => void; openRun: (preset?: { suiteId?: number; agentId?: number }) => void }>({ state: "connecting", subscribe: () => () => {}, openRun: () => {} });
export const useOpenRun = () => useContext(LiveCtx).openRun;
export function useLiveEvents(fn: Listener, deps: unknown[] = []) {
  const { subscribe } = useContext(LiveCtx);
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

const NAV = [
  { group: "Evaluate", items: [{ href: "/", label: "Overview", icon: LayoutDashboard }, { href: "/runs", label: "Runs", icon: PlayCircle }, { href: "/suites", label: "Test suites", icon: FlaskConical }, { href: "/compare", label: "Regressions", icon: GitCompareArrows }] },
  { group: "Chaos", items: [{ href: "/chaos", label: "Chaos studio", icon: Zap }, { href: "/traffic", label: "Live traffic", icon: Radio }] },
  { group: "Platform", items: [{ href: "/agents", label: "Agents", icon: Bot }, { href: "/integrations", label: "Integrations & CI", icon: Plug }, { href: "/audit", label: "Audit log", icon: ShieldCheck }] },
];

export function Shell({ children }: { children: ReactNode }) { return <ToastProvider><Inner>{children}</Inner></ToastProvider>; }

function Inner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const me = useApi<{ user: User }>("/api/auth/me");
  const [drawer, setDrawer] = useState(false);
  const [dark, setDark] = useState(true);
  const [run, setRun] = useState<{ suiteId?: number; agentId?: number } | null>(null);
  const listeners = useRef(new Set<Listener>());
  const toast = useToast();
  const state = useLive((e) => {
    listeners.current.forEach((l) => l(e));
    if (e.type === "run.finished") toast(`Run #${e.runId} finished`, "info");
  });
  const subscribe = useCallback((l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l); }; }, []);
  const openRun = useCallback((p?: { suiteId?: number; agentId?: number }) => setRun(p ?? {}), []);
  const live = useMemo(() => ({ state, subscribe, openRun }), [state, subscribe, openRun]);
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggleTheme = () => { const n = !dark; setDark(n); document.documentElement.classList.toggle("dark", n); try { localStorage.setItem("cr-theme", n ? "dark" : "light"); } catch { /* ignore */ } };

  if (!me.data) return <div className="flex h-screen items-center justify-center text-accent">{me.error ? <p className="text-sm text-bad">{me.error}</p> : <Spinner className="h-6 w-6" />}</div>;
  const user = me.data.user;
  const logout = async () => { await api("/api/auth/logout", { method: "POST" }); router.push("/login"); };

  const nav = (
    <nav className="flex h-full flex-col" aria-label="Main">
      <Link href="/" className="mb-6 flex items-center gap-2.5 px-3 pt-1">
        <img src="/favicon.svg" alt="" className="h-8 w-8" />
        <div><p className="text-sm font-semibold leading-tight">Crucible</p><p className="text-[11px] text-subtle">Agent chaos & evals</p></div>
      </Link>
      <div className="flex-1 space-y-5 overflow-y-auto">
        {NAV.map((g) => (
          <div key={g.group}>
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-subtle">{g.group}</p>
            {g.items.map(({ href, label, icon: Icon }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return <Link key={href} href={href} className={cx("mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition", active ? "bg-accent/12 font-medium text-accent" : "text-muted hover:bg-raised hover:text-fg")}><Icon className="h-4 w-4" />{label}</Link>;
            })}
          </div>
        ))}
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center gap-2.5 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{user.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}</div>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{user.name}</p><p className="text-[11px] capitalize text-subtle">{user.role}</p></div>
          <button onClick={logout} className="btn-ghost p-1.5" aria-label="Sign out" title="Sign out"><LogOut className="h-4 w-4" /></button>
        </div>
      </div>
    </nav>
  );

  return (
    <SessionCtx.Provider value={user}>
      <LiveCtx.Provider value={live}>
        <div className="min-h-screen">
          <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-panel p-3 lg:block">{nav}</aside>
          {drawer && <div className="fixed inset-0 z-40 lg:hidden"><div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} /><aside className="absolute inset-y-0 left-0 w-72 animate-fadeIn border-r border-line bg-panel p-3"><button className="btn-ghost absolute right-2 top-2 p-1.5" onClick={() => setDrawer(false)} aria-label="Close menu"><X className="h-4 w-4" /></button>{nav}</aside></div>}
          <div className="lg:pl-60">
            <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg/80 px-4 backdrop-blur sm:px-6">
              <button className="btn-ghost p-1.5 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
              <span className="text-sm font-semibold lg:hidden">Crucible</span>
              <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
                <span className="inline-flex items-center gap-2 text-xs text-muted" title={`Realtime: ${state}`}>
                  <span className="relative flex h-2 w-2">{state === "live" && <span className="absolute inset-0 animate-pulseRing rounded-full bg-ok" />}<span className={cx("relative h-2 w-2 rounded-full", state === "live" ? "bg-ok" : state === "connecting" ? "bg-warn" : "bg-bad")} /></span>
                  <span className="hidden sm:inline">{state === "live" ? "Live" : state === "connecting" ? "Connecting" : "Reconnecting"}</span>
                </span>
                {can(user, "engineer") && <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => openRun()}><Rocket className="h-3.5 w-3.5" /><span className="hidden sm:inline">New run</span></button>}
                <button className="btn-ghost p-2" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
              </div>
            </header>
            <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
          </div>
          <RunDialog preset={run} onClose={() => setRun(null)} />
        </div>
      </LiveCtx.Provider>
    </SessionCtx.Provider>
  );
}

function RunDialog({ preset, onClose }: { preset: { suiteId?: number; agentId?: number } | null; onClose: () => void }) {
  const suites = useApi<{ id: number; name: string; scenarios: number; chaos_scenarios: number }[]>(preset ? "/api/suites" : null);
  const agents = useApi<{ id: number; name: string; slug: string; kind: string }[]>(preset ? "/api/agents" : null);
  const [f, setF] = useState({ suiteId: 0, agentId: 0, label: "", seed: "", repeats: 1, chaos: true, baseline: false });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  useEffect(() => {
    if (!preset) return;
    setF((x) => ({ ...x, suiteId: preset.suiteId ?? suites.data?.[0]?.id ?? 0, agentId: preset.agentId ?? agents.data?.find((a) => a.slug === "support-hardened")?.id ?? agents.data?.[0]?.id ?? 0 }));
  }, [preset, suites.data, agents.data]);
  const suite = suites.data?.find((s) => s.id === f.suiteId);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api<{ id: number }>("/api/runs", { method: "POST", json: { suiteId: f.suiteId, agentId: f.agentId, label: f.label || undefined, seed: f.seed ? Number(f.seed) : undefined, repeats: f.repeats, chaos: f.chaos, baseline: f.baseline } });
      toast("Run queued", "ok"); onClose(); router.push(`/runs/${r.id}`);
    } catch (err) { toast((err as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!preset} onClose={onClose} title="Launch an evaluation run">
      <form onSubmit={submit} className="space-y-4" id="run-form">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">Test suite</span><select className="input" value={f.suiteId} onChange={(e) => setF({ ...f, suiteId: Number(e.target.value) })}>{suites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="block"><span className="label">Agent under test</span><select className="input" value={f.agentId} onChange={(e) => setF({ ...f, agentId: Number(e.target.value) })}>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        </div>
        {suite && <p className="text-xs text-muted">{suite.scenarios} scenarios, {suite.chaos_scenarios} with fault injection · {suite.scenarios * f.repeats} cases</p>}
        <label className="block"><span className="label">Label (prompt version, model, branch…)</span><input className="input" placeholder="e.g. prompt v14 · new retry policy" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={120} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">Seed (blank = random)</span><input className="input mono" inputMode="numeric" placeholder="reproducible chaos" value={f.seed} onChange={(e) => setF({ ...f, seed: e.target.value.replace(/\D/g, "") })} /></label>
          <label className="block"><span className="label">Repeats per scenario</span><input className="input" type="number" min={1} max={10} value={f.repeats} onChange={(e) => setF({ ...f, repeats: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} /></label>
        </div>
        <div className="space-y-2 rounded-lg border border-line bg-raised/40 p-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[rgb(var(--accent))]" checked={f.chaos} onChange={(e) => setF({ ...f, chaos: e.target.checked })} />Inject faults (chaos mode)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[rgb(var(--accent))]" checked={f.baseline} onChange={(e) => setF({ ...f, baseline: e.target.checked })} />Use as the suite baseline when complete</label>
        </div>
        <div className="flex justify-end gap-2 pt-1"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !f.suiteId || !f.agentId}>{busy && <Spinner />}<Rocket className="h-4 w-4" />Start run</button></div>
      </form>
    </Modal>
  );
}
