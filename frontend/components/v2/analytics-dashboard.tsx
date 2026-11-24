"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import {
  BarChart3,
  Building2,
  ChevronDown,
  ClipboardCheck,
  FileCheck2,
  Files,
  FolderOpen,
  ShieldCheck,
  Users,
} from "lucide-react";
import { reviewStatus } from "@/lib/review";
import { dateText, outcomes } from "@/lib/api";
import {
  evidenceStatusCounts,
  officialEvidenceStatus,
  officialStatusColors,
} from "@/lib/evidence-intelligence";
import { useEvidenceIntelligence } from "./use-evidence-intelligence";
import { useAuth } from "./auth-provider";
import { dashboardDistribution, dashboardMetrics } from "@/lib/dashboard-data";

function EvidenceDonut({ values, unit }: { values: Array<{ label: string; value: number; color: string }>; unit: string }) {
  const total = values.reduce((sum, item) => sum + item.value, 0);
  let offset = 0;
  return (
    <div className="analytics-donut-wrap">
      <svg viewBox="0 0 120 120" role="img" aria-label={`${unit} distribution`}>
        <circle cx="60" cy="60" r="42" className="donut-track" />
        {values.map((item) => {
          const length = total ? (item.value / total) * 100 : 0;
          const currentOffset = -offset;
          offset += length;
          return <circle key={item.label} cx="60" cy="60" r="42" pathLength="100" stroke={item.color} strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={currentOffset} className="donut-segment"><title>{item.label}: {item.value}</title></circle>;
        })}
        <text x="60" y="57" textAnchor="middle" className="donut-total">{total}</text>
        <text x="60" y="72" textAnchor="middle" className="donut-caption">{unit}</text>
      </svg>
      <div className="analytics-legend">
        {values.map((item) => <div key={item.label}><i style={{ background: item.color }} /><span>{item.label}</span><strong>{item.value}</strong></div>)}
      </div>
    </div>
  );
}

function HistoricalActivity({ evidence }: { evidence: ReturnType<typeof useEvidenceIntelligence> }) {
  const events = [...(evidence.board?.events ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8);
  return <article className="v2-card chart-card trend-card">
    <div className="card-heading"><div><span className="v2-eyebrow">Historical trend</span><h2>{evidence.history.length ? "Verification snapshots" : "Corrective work activity"}</h2></div></div>
    {evidence.evidenceState === "loading" ? <p className="chart-empty">Loading dated activity…</p>
      : evidence.history.length ? <ol className="dashboard-history">{[...evidence.history].reverse().map(({ run, results, error }) => <li key={run.id}><time dateTime={run.created_at}>{dateText(run.created_at)}</time><strong>{results ? `${results.length} statements` : error}</strong><small>{run.status} · {run.manifest.length} documents · {run.id.slice(0, 6)}{results ? ` · ${evidenceStatusCounts(results).counts.Supported} supported` : ""}</small></li>)}</ol>
      : events.length ? <ol className="dashboard-history">{events.map((event) => <li key={event.id}><time dateTime={event.created_at}>{dateText(event.created_at)}</time><strong>{event.action.replaceAll("_", " ")}</strong><small>{evidence.board?.tasks.find((task) => task.id === event.task_id)?.title || "Case task update"}</small></li>)}</ol>
      : <p className="chart-empty">{evidence.boardError || "No dated verification snapshots or corrective-work events are available to this account for the selected case."}</p>}
    <p className="chart-explanation">{evidence.historyRestricted ? "Verification history is reviewer-restricted. Only authorized selected-case corrective activity is shown." : "Up to 8 selected-case saved runs, or recorded corrective events when no readable run is available. Snapshot counts are not a factory safety score."}</p>
  </article>;
}

export function AnalyticsDashboard() {
  const router = useRouter();
  const auth = useAuth();
  const evidence = useEvidenceIntelligence();
  useEffect(() => {
    if (auth.state === "signed-out") router.replace("/login");
  }, [auth.state, router]);

  const metrics = dashboardMetrics(evidence.data, evidence.evidenceState === "loading");
  const presentation = useMemo(() => evidence.dossier ? dashboardDistribution({ dossier: evidence.dossier, results: evidence.results, board: evidence.board }) : null, [evidence.dossier, evidence.results, evidence.board]);
  const distribution = presentation?.values ?? [];
  const distributionTotal = distribution.reduce((sum, item) => sum + item.value, 0);
  const selectedCase = evidence.cases.find((item) => item.id === evidence.selectedCaseId);
  const role = auth.profile?.role;
  const reviewerWorkspace = role !== "admin";
  const emptyDocuments = evidence.documentError || "No authorized documents are available for this selected case.";
  const emptyResults = evidence.evidenceState === "loading" ? "Loading evidence…"
    : evidence.resultsError || (evidence.historyRestricted ? "Verification results are reviewer-restricted for this account."
      : evidence.run ? "The selected readable run returned no published assessments." : "No complete or partial verification run is visible for this selected case.");
  const caseHref = evidence.selectedCaseId ? `/workspace?case=${encodeURIComponent(evidence.selectedCaseId)}&view=overview` : "/workspace?view=cases";
  const reviewHref = evidence.selectedCaseId && evidence.run ? `/workspace?case=${encodeURIComponent(evidence.selectedCaseId)}&view=review&run=${encodeURIComponent(evidence.run.id)}` : caseHref;
  const documentHref = evidence.selectedCaseId ? `/workspace?case=${encodeURIComponent(evidence.selectedCaseId)}&view=documents` : caseHref;

  const quickLinks = role === "admin"
      ? [
          { label: "Factories", href: "/workspace?view=factories", icon: Building2 },
          { label: "Team management", href: "/workspace?view=reviewers", icon: Users },
        ]
      : [
          { label: "Cases", href: "/workspace?view=cases", icon: FolderOpen },
          { label: "Evidence", href: caseHref, icon: FileCheck2 },
          { label: "Reviews", href: reviewHref, icon: ClipboardCheck },
          { label: "Documents", href: documentHref, icon: Files },
        ];

  if (auth.state === "loading" || evidence.accountState === "restoring" || evidence.accountState === "loading") {
    return <main className="v2-page dashboard-loading"><span className="v2-loader" />Opening your dashboard…</main>;
  }
  if (auth.state === "error") {
    return <main className="v2-page dashboard-loading"><strong>Dashboard unavailable</strong><span>{auth.error}</span><Link className="v2-button secondary" href="/login">Return to sign in</Link></main>;
  }
  if (auth.state !== "authenticated") return <main className="v2-page dashboard-loading">Redirecting to sign in…</main>;

  return (
    <div className="analytics-content dashboard-page-content">
          {reviewerWorkspace && evidence.realMode && (
            <div className="dashboard-page-tools" aria-label="Dashboard filters">
              <div className="dashboard-selectors">
                {role === "reviewer" ? (
                  <label className="dashboard-case-selector"><span>Factory</span><select aria-label="Select factory" title={evidence.selectedFactory || "No assigned factories"} value={evidence.selectedFactoryId} disabled={!evidence.factories.length} onChange={(event) => evidence.setSelectedFactoryId(event.target.value)}>{evidence.factories.length ? evidence.factories.map((factory) => <option key={factory.id} value={factory.id}>{factory.name}</option>) : <option value="">No assigned factories</option>}</select><ChevronDown /></label>
                ) : <div className="dashboard-factory-value"><span>Factory</span><strong title={evidence.selectedFactory}>{evidence.selectedFactory || "No assigned factory"}</strong></div>}
                <label className="dashboard-case-selector"><span>Case</span><select aria-label="Select case" title={selectedCase?.title || "No authorized cases"} value={evidence.selectedCaseId} onChange={(event) => evidence.setSelectedCaseId(event.target.value)} disabled={!evidence.factoryCases.length}>{evidence.factoryCases.length ? evidence.factoryCases.map((item) => <option key={item.id} value={item.id}>{item.factory} · {item.title}</option>) : <option>No authorized cases</option>}</select><ChevronDown /></label>
              </div>
            </div>
          )}
          <section className="analytics-welcome"><div><p>{selectedCase ? `${selectedCase.factory} · ${selectedCase.title}` : role === "admin" ? "Administration overview" : "Authorized evidence overview"}</p><h2>Good evidence makes every review clearer.</h2><span>Document classifications below describe evidence support; they are not a factory safety score.</span></div><BarChart3 /></section>

          {!reviewerWorkspace ? (
            <section className="v2-card dashboard-empty"><ShieldCheck /><h2>Administrative account</h2><p>The backend does not expose factory case evidence through the administrator role. Use your authorized management tools without bypassing role boundaries.</p><Link className="v2-button" href="/workspace?view=factories">Open admin workspace</Link></section>
          ) : evidence.error ? (
            <section className="v2-card dashboard-empty"><FileCheck2 /><h2>Evidence could not be loaded</h2><p>{evidence.error}</p></section>
          ) : evidence.realMode && !evidence.cases.length ? (
            <section className="v2-card dashboard-empty"><FolderOpen /><h2>{evidence.factories.length ? "No authorized cases for this factory" : "No assigned factories"}</h2><p>{evidence.factories.length ? "This selected factory has no cases visible to your account. Choose another assigned factory when available." : "Ask an administrator to confirm your factory assignment."}</p><Link className="v2-button secondary" href="/workspace?view=cases">Open case workspace</Link></section>
          ) : (
            <>
              <section className="kpi-grid">
                <article className="kpi-card featured"><span>Authorized cases</span><strong>{evidence.cases.length}</strong><small>Selected factory · visible to this account</small></article>
                {metrics.map((metric) => <article className="kpi-card" key={metric.label}><span>{metric.label}</span><strong>{metric.display}</strong><small>{metric.message}</small></article>)}
              </section>

              {evidence.resultsError && <p className="v2-workspace-notice" role="status">{evidence.resultsError} Other authorized case records remain available below.</p>}
              <section className="analytics-grid">
                <article className="v2-card chart-card distribution-card"><div className="card-heading"><div><span className="v2-eyebrow">Classification</span><h2>{presentation?.title || "Loading records…"}</h2></div><FileCheck2 /></div>{distributionTotal ? <EvidenceDonut values={distribution} unit={presentation!.unit} /> : <p className="chart-empty">{evidence.evidenceState === "loading" ? "Loading authorized records…" : emptyDocuments}</p>}<p className="chart-explanation">{presentation?.note}</p></article>
                <article className="v2-card chart-card bars-card"><div className="card-heading"><div><span className="v2-eyebrow">{presentation?.unit === "statements" ? "Finding counts" : "Record counts"}</span><h2>{presentation?.countTitle || "Loading counts…"}</h2></div><BarChart3 /></div>{distributionTotal ? <div className="category-bars">{distribution.map((item) => <div key={item.label}><span>{item.label}</span><i><b style={{ width: `${(item.value / distributionTotal) * 100}%`, background: item.color }} /></i><strong>{item.value}</strong></div>)}</div> : <p className="chart-empty">{evidence.evidenceState === "loading" ? "Loading counts…" : emptyDocuments}</p>}</article>
                <HistoricalActivity evidence={evidence} />
              </section>

              <section className="v2-card activity-card"><div className="card-heading"><div><span className="v2-eyebrow">Selected case</span><h2>Recent evidence records</h2></div>{evidence.selectedCaseId && <Link href={reviewHref}>Open review workflow</Link>}</div>{evidence.results.length ? <div className="activity-table"><div className="activity-table-head"><span>Source</span><span>Category</span><span>Review</span><span>Page</span></div>{evidence.results.slice(0, 6).map((result) => { const status = officialEvidenceStatus(result.outcome); return <Link href={`${reviewHref}&item=${encodeURIComponent(result.id)}`} key={result.id}><span><strong>{result.claim.source.document}</strong><small>{result.claim.source.quote}</small></span><span className="status-pill" style={{ color: status ? officialStatusColors[status] : undefined }}>{status || outcomes[result.outcome]}</span><span>{reviewStatus(result)}</span><span>{result.claim.source.page}</span></Link>; })}</div> : <div className="table-empty">{emptyResults}</div>}</section>

              <section className="quick-actions"><h2>Quick actions</h2><div>{quickLinks.map(({ label, href, icon: Icon }) => <Link className="v2-card" href={href} key={label}><Icon /><span>{label}</span></Link>)}</div></section>
            </>
          )}
          <footer className="dashboard-footer"><span>SafetyProof AI · Documentary evidence review</span><span>{dateText(new Date().toISOString())}</span></footer>
    </div>
  );
}
