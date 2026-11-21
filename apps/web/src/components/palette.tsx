"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft, PlayCircle, FlaskConical, LayoutDashboard, Rocket } from "lucide-react";
import { useApi } from "@/lib/api";
import { cx } from "./ui";

type Item = { label: string; hint: string; href?: string; action?: () => void; icon: typeof Search };
const PAGES: [string, string][] = [["Overview", "/"], ["Runs", "/runs"], ["Test suites", "/suites"], ["Regressions", "/compare"], ["Schedules", "/schedules"], ["Chaos studio", "/chaos"], ["Live experiments", "/experiments"], ["Live traffic", "/traffic"], ["Agents", "/agents"], ["Integrations & CI", "/integrations"], ["Audit log", "/audit"]];

/** Ctrl/⌘+K: jump to any page, suite or recent run, or launch a run. */
export function CommandPalette({ open, onClose, onNewRun }: { open: boolean; onClose: () => void; onNewRun?: () => void }) {
  const runs = useApi<{ id: number; label: string; agent: string; suite: string }[]>(open ? "/api/runs?limit=30" : null);
  const suites = useApi<{ id: number; name: string }[]>(open ? "/api/suites" : null);
  const [query, setQuery] = useState(""), [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  useEffect(() => { if (open) { setQuery(""); setSel(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);

  const items = useMemo(() => {
    const all: Item[] = [
      ...(onNewRun ? [{ label: "Launch a new run", hint: "action", action: onNewRun, icon: Rocket }] : []),
      ...PAGES.map(([label, href]) => ({ label, hint: "page", href, icon: LayoutDashboard })),
      ...(suites.data ?? []).map((s) => ({ label: s.name, hint: "suite", href: `/suites/${s.id}`, icon: FlaskConical })),
      ...(runs.data ?? []).map((r) => ({ label: `#${r.id} ${r.label}`, hint: `${r.agent} · ${r.suite}`, href: `/runs/${r.id}`, icon: PlayCircle })),
    ];
    const t = query.trim().toLowerCase();
    if (!t) return all.slice(0, 14);
    // simple fuzzy: every term must appear somewhere in label or hint
    return all.filter((i) => t.split(/\s+/).every((w) => `${i.label} ${i.hint}`.toLowerCase().includes(w))).slice(0, 20);
  }, [query, runs.data, suites.data, onNewRun]);

  const go = (i: Item | undefined) => { if (!i) return; onClose(); if (i.action) i.action(); else if (i.href) router.push(i.href); };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Command palette" className="card w-full max-w-xl animate-fadeIn overflow-hidden shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="h-4 w-4 text-subtle" />
          <input ref={input} className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" placeholder="Jump to a page, suite or run…" value={query} aria-label="Search"
            onChange={(e) => { setQuery(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); go(items[sel]); }
              else if (e.key === "Escape") onClose();
            }} />
          <span className="kbd">Esc</span>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
          {!items.length && <li className="px-3 py-6 text-center text-sm text-muted">No matches</li>}
          {items.map((i, k) => (
            <li key={`${i.hint}-${i.label}`} role="option" aria-selected={k === sel}>
              <button onMouseEnter={() => setSel(k)} onClick={() => go(i)} className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm", k === sel ? "bg-accent/12 text-fg" : "text-muted")}>
                <i.icon className={cx("h-4 w-4 shrink-0", k === sel ? "text-accent" : "text-subtle")} />
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                <span className="shrink-0 text-[11px] text-subtle">{i.hint}</span>
                {k === sel && <CornerDownLeft className="h-3.5 w-3.5 text-subtle" />}
              </button>
            </li>))}
        </ul>
      </div>
    </div>
  );
}
