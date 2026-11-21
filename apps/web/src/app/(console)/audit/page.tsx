"use client";
import { ShieldCheck } from "lucide-react";
import { useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Card, PageHeader, Skeleton, ErrorBox, Badge } from "@/components/ui";

export default function Audit() {
  const a = useApi<any[]>("/api/audit"); // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Who launched runs, changed suites, rotated keys or triggered CI gates." />
      {a.error ? <ErrorBox message={a.error} /> : !a.data ? <Skeleton className="h-96" /> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-subtle"><th className="px-4 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Actor</th><th className="px-3 py-2 font-medium">Action</th><th className="hidden px-3 py-2 font-medium md:table-cell">Target</th><th className="hidden px-4 py-2 font-medium lg:table-cell">Details</th></tr></thead>
            <tbody>{a.data.map((r) => (
              <tr key={r.id} className="table-row">
                <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted">{dateTime(r.ts)}</td>
                <td className="px-3 py-2.5 text-xs">{r.actor}</td>
                <td className="px-3 py-2.5"><Badge tone={r.action.startsWith("key") ? "warn" : r.action.startsWith("ci") ? "info" : "neutral"}><ShieldCheck className="h-3 w-3" />{r.action}</Badge></td>
                <td className="hidden px-3 py-2.5 text-xs mono md:table-cell">{r.target ?? "—"}</td>
                <td className="hidden max-w-md truncate px-4 py-2.5 text-xs text-subtle mono lg:table-cell">{JSON.stringify(r.data)}</td>
              </tr>))}</tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
