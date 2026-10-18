"use client";

import { useSystemStatus } from "./statusApi";
import { Button, Notice } from "@/components/ui";
import { Activity, Check, Clock3, RefreshCw, Server, TriangleAlert, X } from "lucide-react";

function StatePill({ status }: { status: string }) {
  const style = status === "up" || status === "ok" ? "bg-mint text-moss" : status === "degraded" ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700";
  const Icon = status === "up" || status === "ok" ? Check : status === "degraded" ? TriangleAlert : X;
  return <span className={"inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium capitalize " + style}><Icon size={13} />{status}</span>;
}

export function StatusPage() {
  const { health, readiness } = useSystemStatus();
  const refresh = () => { void health.refetch(); void readiness.refetch(); };
  const report = readiness.data;
  return (
    <div className="mx-auto max-w-4xl space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">Service health</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">System status</h1><p className="mt-2 text-sm text-muted">Current availability of the workspace and its connected services.</p></div><Button variant="secondary" onClick={refresh} disabled={health.isFetching || readiness.isFetching}><RefreshCw size={15} className={health.isFetching || readiness.isFetching ? "animate-spin" : ""} />Refresh</Button></header>
      {health.isError && <Notice>{health.error.message}</Notice>}
      {readiness.isError && <Notice>{readiness.error.message}</Notice>}
      <section className="rounded-[24px] border border-line bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4"><div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-mint text-moss"><Server size={19} /></span><div><h2 className="font-semibold text-ink">Backend readiness</h2><p className="mt-1 text-xs text-muted">Required and optional dependencies</p></div></div>{report && <StatePill status={report.status} />}</div>
        {!report && !readiness.isError && <p className="mt-6 text-sm text-muted">Checking connected services…</p>}
        {report && <div className="mt-6 divide-y divide-line">{Object.entries(report.components).map(([name, status]) => <div key={name} className="flex items-center justify-between gap-4 py-3"><span className="text-sm capitalize text-ink">{name.replace(/[:_-]/g, " ")}</span><StatePill status={status} /></div>)}</div>}
      </section>
      <section className="rounded-[24px] border border-line bg-white p-6 shadow-sm"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#f1f4ef] text-muted"><Activity size={19} /></span><div className="flex-1"><h2 className="font-semibold text-ink">API process</h2><p className="mt-1 text-xs text-muted">Liveness check</p></div>{health.data && <StatePill status={health.data.status} />}</div>{health.data && <p className="mt-4 flex items-center gap-2 text-xs text-muted"><Clock3 size={13} />Running for {Math.floor(health.data.uptimeSeconds / 60)} minutes · checked {new Date(health.data.timestamp).toLocaleTimeString()}</p>}</section>
      <p className="text-xs text-muted">Status refreshes every 30 seconds while this page is open.</p>
    </div>
  );
}
