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
import { dateText } from "@/lib/api";
import {
  evidenceStatusCounts,
  officialEvidenceStatus,
  officialStatusColors,
} from "@/lib/evidence-intelligence";
import { useEvidenceIntelligence } from "./use-evidence-intelligence";
import { useAuth } from "./auth-provider";

const categories = Object.keys(officialStatusColors) as Array<keyof typeof officialStatusColors>;

function EvidenceDonut({ values }: { values: Array<{ label: string; value: number; color: string }> }) {
  const total = values.reduce((sum, item) => sum + item.value, 0);
  let offset = 0;
  return (
    <div className="analytics-donut-wrap">
      <svg viewBox="0 0 120 120" role="img" aria-label="Evidence classification distribution">
        <circle cx="60" cy="60" r="42" className="donut-track" />
        {values.map((item) => {
          const length = total ? (item.value / total) * 100 : 0;
          const currentOffset = -offset;
          offset += length;
          return <circle key={item.label} cx="60" cy="60" r="42" pathLength="100" stroke={item.color} strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={currentOffset} className="donut-segment"><title>{item.label}: {item.value}</title></circle>;
        })}
        <text x="60" y="57" textAnchor="middle" className="donut-total">{total}</text>
        <text x="60" y="72" textAnchor="middle" className="donut-caption">findings</text>
      </svg>
      <div className="analytics-legend">
        {values.map((item) => <div key={item.label}><i style={{ background: item.color }} /><span>{item.label}</span><strong>{item.value}</strong></div>)}
      </div>
    </div>
  );
}

export function AnalyticsDashboard() {
  const router = useRouter();
  const auth = useAuth();
  const evidence = useEvidenceIntelligence();
  useEffect(() => {
    if (auth.state === "signed-out") router.replace("/login");
  }, [auth.state, router]);

  const summary = useMemo(() => evidenceStatusCounts(evidence.results), [evidence.results]);
  const pending = evidence.results.filter((result) => reviewStatus(result) === "Pending review").length;
  const distribution = categories.map((label) => ({ label, value: summary.counts[label], color: officialStatusColors[label] }));
  const selectedCase = evidence.cases.find((item) => item.id === evidence.selectedCaseId);
  const role = auth.profile?.role;
  const reviewerWorkspace = role !== "admin";
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

  if (auth.state === "loading" || evidence.accountState === "restoring") {
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
                <label><span>Factory</span><select aria-label="Select factory" title={evidence.selectedFactory || "No authorized factories"} value={evidence.selectedFactory} onChange={(event) => { evidence.setSelectedFactory(event.target.value); evidence.setSelectedCaseId(""); }} disabled={!evidence.factories.length}>{evidence.factories.length ? evidence.factories.map((factory) => <option key={factory}>{factory}</option>) : <option>No authorized factories</option>}</select><ChevronDown /></label>
                <label><span>Case</span><select aria-label="Select case" title={selectedCase?.title || "No authorized cases"} value={evidence.selectedCaseId} onChange={(event) => evidence.setSelectedCaseId(event.target.value)} disabled={!evidence.factoryCases.length}>{evidence.factoryCases.length ? evidence.factoryCases.map((item) => <option key={item.id} value={item.id}>{item.title}</option>) : <option>No authorized cases</option>}</select><ChevronDown /></label>
              </div>
            </div>
          )}
          <section className="analytics-welcome"><div><p>{selectedCase ? `${selectedCase.factory} · ${selectedCase.title}` : role === "admin" ? "Administration overview" : "Authorized evidence overview"}</p><h2>Good evidence makes every review clearer.</h2><span>Document classifications below describe evidence support; they are not a factory safety score.</span></div><BarChart3 /></section>

          {!reviewerWorkspace ? (
            <section className="v2-card dashboard-empty"><ShieldCheck /><h2>Administrative account</h2><p>The backend does not expose factory case evidence through the administrator role. Use your authorized management tools without bypassing role boundaries.</p><Link className="v2-button" href="/workspace?view=factories">Open admin workspace</Link></section>
          ) : evidence.error ? (
            <section className="v2-card dashboard-empty"><FileCheck2 /><h2>Evidence could not be loaded</h2><p>{evidence.error}</p></section>
          ) : evidence.realMode && !evidence.cases.length ? (
            <section className="v2-card dashboard-empty"><FolderOpen /><h2>No authorized cases yet</h2><p>Cases assigned to your account will appear here. No demo findings or fabricated statistics are shown.</p><Link className="v2-button secondary" href="/workspace?view=cases">Open case workspace</Link></section>
          ) : (
            <>
              <section className="kpi-grid">
                <article className="kpi-card featured"><span>Authorized cases</span><strong>{evidence.cases.length}</strong><small>Visible to this account</small></article>
                <article className="kpi-card"><span>Evidence findings</span><strong>{evidence.results.length}</strong><small>Selected readable run</small></article>
                <article className="kpi-card"><span>Supported</span><strong>{summary.counts.Supported}</strong><small>Documentary support found</small></article>
                <article className="kpi-card"><span>Pending review</span><strong>{pending}</strong><small>Human action required</small></article>
              </section>

              <section className="analytics-grid">
                <article className="v2-card chart-card distribution-card"><div className="card-heading"><div><span className="v2-eyebrow">Classification</span><h2>Evidence distribution</h2></div><FileCheck2 /></div><EvidenceDonut values={distribution} /></article>
                <article className="v2-card chart-card bars-card"><div className="card-heading"><div><span className="v2-eyebrow">Finding counts</span><h2>Review categories</h2></div><BarChart3 /></div><div className="category-bars">{distribution.map((item) => <div key={item.label}><span>{item.label}</span><i><b style={{ width: `${evidence.results.length ? Math.max(4, (item.value / evidence.results.length) * 100) : 0}%`, background: item.color }} /></i><strong>{item.value}</strong></div>)}</div></article>
                <article className="v2-card chart-card trend-card"><div className="card-heading"><div><span className="v2-eyebrow">Historical trend</span><h2>Change over time</h2></div></div><div className="chart-empty"><BarChart3 /><strong>Not available</strong><span>No genuine dated result series is exposed for this case.</span></div></article>
              </section>

              <section className="v2-card activity-card"><div className="card-heading"><div><span className="v2-eyebrow">Selected case</span><h2>Recent evidence records</h2></div>{evidence.selectedCaseId && <Link href={reviewHref}>Open review workflow</Link>}</div>{evidence.results.length ? <div className="activity-table"><div className="activity-table-head"><span>Source</span><span>Category</span><span>Review</span><span>Page</span></div>{evidence.results.slice(0, 6).map((result) => { const status = officialEvidenceStatus(result.outcome); return <Link href={`${reviewHref}&item=${encodeURIComponent(result.id)}`} key={result.id}><span><strong>{result.claim.source.document}</strong><small>{result.claim.source.quote}</small></span><span className="status-pill" style={{ color: status ? officialStatusColors[status] : undefined }}>{status || "Not available"}</span><span>{reviewStatus(result)}</span><span>{result.claim.source.page}</span></Link>; })}</div> : <div className="table-empty">{evidence.evidenceState === "loading" ? "Loading evidence…" : evidence.run ? "This run contains no published findings." : "No complete or partial verification run is available."}</div>}</section>

              <section className="quick-actions"><h2>Quick actions</h2><div>{quickLinks.map(({ label, href, icon: Icon }) => <Link className="v2-card" href={href} key={label}><Icon /><span>{label}</span></Link>)}</div></section>
            </>
          )}
          <footer className="dashboard-footer"><span>SafetyProof AI · Documentary evidence review</span><span>{dateText(new Date().toISOString())}</span></footer>
    </div>
  );
}
