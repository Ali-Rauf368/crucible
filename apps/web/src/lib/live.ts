"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

const API_PUBLIC = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4200";
export type LiveEvent = { type: string; runId?: number; [k: string]: unknown };
export type LiveState = "connecting" | "live" | "offline";
const TYPES = ["run.created", "run.updated", "run.finished", "case.finished", "span"];

/** SSE with a 2-minute ticket fetched per (re)connect and exponential backoff. `traffic` adds per-span events. */
export function useLive(onEvent: (e: LiveEvent) => void, { traffic = false } = {}) {
  const [state, setState] = useState<LiveState>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    let es: EventSource | null = null, stopped = false, retry = 0, timer: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const { ticket } = await api<{ ticket: string }>("/api/auth/stream-ticket");
        if (stopped) return;
        es = new EventSource(`${API_PUBLIC}/api/stream?ticket=${encodeURIComponent(ticket)}${traffic ? "&traffic=1" : ""}`);
        es.addEventListener("ready", () => { retry = 0; setState("live"); });
        for (const t of TYPES) es.addEventListener(t, (m) => { try { handler.current(JSON.parse((m as MessageEvent).data)); } catch { /* ignore */ } });
        es.onerror = () => { es?.close(); setState("offline"); schedule(); };
      } catch { setState("offline"); schedule(); }
    };
    const schedule = () => { if (!stopped) timer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** retry++)); };
    connect();
    return () => { stopped = true; clearTimeout(timer); es?.close(); };
  }, [traffic]);
  return state;
}
