"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ClipboardCheck,
  FileText,
  Printer,
  ScanLine,
} from "lucide-react";
import {
  Action,
  CapAnalysis,
  CapReview,
  Dossier,
  Outcome,
  Ref,
  Result,
  Run,
  api,
  dateText,
  message,
  outcomes,
} from "@/lib/api";
import { reviewStatus } from "@/lib/review";
import { Preview } from "./viewer";
import { Busy, ErrorNote, Tag } from "./ui";
import { JobRow } from "./documents";

type Props = {
  dossier: Dossier;
  token: string;
  runId: string | null;
  itemId: string | null;
  go: (run: string, item?: string) => void;
  preview: (item: Preview) => void;
  refresh: () => Promise<void>;
};
type PrintableReport = {
  results: Result[];
  run: Run & { cap_analysis?: CapAnalysis | null };
  cap_reviews: CapReview[];
};
const tone: Record<Outcome, string> = {
  contradicted: "red",
  unsupported: "amber",
  unresolved: "amber",
  supported: "green",
  needs_review: "neutral",
  not_assessed: "neutral",
};
const decisions: Record<Action, string> = {
  accept: "Accept flag",
  dismiss: "Dismiss flag",
  request_evidence: "Request evidence",
  comment: "Add comment",
};

function plainResult(outcome: Outcome) {
  switch (outcome) {
    case "supported":
      return "The cited document contains information that supports this statement. Read the quote below to see what it says.";
    case "contradicted":
      return "The cited records give different facts about the same subject and time period.";
    case "unresolved":
      return "The inspection report records this problem. The selected records do not show a later independent inspection confirming that it was fixed.";
    case "unsupported":
      return "The selected records do not contain enough information to confirm this statement.";
    case "needs_review":
      return "The documents are unclear or do not agree. A reviewer should compare the quoted pages before deciding.";
    case "not_assessed":
      return "This check is incomplete. The available pages or search were not enough to reach a result.";
  }
}

function revealAssessment(id: string) {
  const detail = document.getElementById(`assessment-detail-${id}`);
  detail?.focus({ preventScroll: true });
  detail?.scrollIntoView({ block: "start" });
}

function citation(ref: Ref, heading: string, preview: (item: Preview) => void) {
  return (
    <article className="source-card">
      <h3>{heading}</h3>
      <blockquote dir="auto">{ref.quote}</blockquote>
      <button
        onClick={() =>
          preview({ version: ref.version_id, title: ref.document, anchor: ref })
        }
      >
        <FileText size={16} />
        {ref.document} · p. {ref.page}
        <ArrowRight size={14} />
      </button>
      <small>
        Revision {ref.revision} ·{" "}
        {ref.method === "ocr" ? "OCR transcription" : "PDF text"}
      </small>
    </article>
  );
}

export function Analysis({
  dossier: d,
  token,
  runId,
  itemId,
  go,
  preview,
  refresh,
}: Props) {
  const run = d.runs.find((r) => r.id === runId) || d.runs[0];
  const readable = run && ["complete", "partial"].includes(run.status);
  const results = useQuery({
    queryKey: ["results", run?.id],
    queryFn: () => api<Result[]>("/v1/runs/" + run.id + "/results", token),
    enabled: !!readable,
  });
  const [filter, setFilter] = useState("all");
  const [reviewFilter, setReviewFilter] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [error, setError] = useState("");
  const [printData, setPrintData] = useState<PrintableReport | null>(null);
  const job = d.jobs.find((j) => j.run_id === run?.id);
  const writable =
    d.role === "reviewer" && !d.case.archived && !d.case.deleting;
  const rows = results.data || [];
  const selected = rows.find((r) => r.id === itemId);
  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId) revealAssessment(selectedId);
  }, [selectedId]);
  const displayed = rows.filter(
    (r) =>
      (filter === "all" || r.outcome === filter) &&
      (reviewFilter === "all" || reviewFilter === reviewStatus(r)) &&
      (severity === "all" || severity === r.claim.severity),
  );
  async function retry() {
    setError("");
    try {
      await api("/v1/jobs/" + job?.id + "/retry", token, "POST");
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  }
  async function printReport() {
    setError("");
    try {
      const report = await api<PrintableReport>(
        "/v1/runs/" + run.id + "/report",
        token,
      );
      setPrintData(report);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          window.print();
          setPrintData(null);
        }),
      );
    } catch (e) {
      setError(message(e));
    }
  }
  if (!run)
    return (
      <section className="panel blank">
        <div className="large-icon">
          <ClipboardCheck />
        </div>
        <h2>No verification runs yet</h2>
        <p>Select records and run verification from Documents.</p>
      </section>
    );
  return (
    <>
      <section className="panel">
        <div className="section-head">
          <div>
            <h2>Evidence review</h2>
            <p>
              {d.case.title} · {run.manifest.length} documents
            </p>
          </div>
          <div className="inline-actions">
            <Tag tone={run.status === "complete" ? "green" : "amber"}>
              {run.status}
            </Tag>
            {readable && (
              <button
                disabled={!results.isSuccess}
                onClick={() => void printReport()}
              >
                <Printer size={16} />
                Print review
              </button>
            )}
          </div>
        </div>
        <details className="coverage">
          <summary>Analysis snapshot · {dateText(run.created_at)}</summary>
          <ul>
            {run.manifest.map((v) => (
              <li key={v.id}>
                {v.title} · revision {v.revision} · {v.readable_pages}/
                {v.page_count} readable pages
              </li>
            ))}
          </ul>
          <p>
            {run.config.pipeline} · {run.config.llm} · {run.config.embedding}
          </p>
          {run.usage.unanchored_extractions ? (
            <p>
              Unverified source quotations excluded:{" "}
              {run.usage.unanchored_extractions}
            </p>
          ) : null}
        </details>
        {error && <ErrorNote text={error} />}
        {!readable &&
          (job ? (
            <JobRow
              job={job}
              retry={writable ? () => void retry() : undefined}
            />
          ) : (
            <Busy />
          ))}
        {readable && (
          <>
            <div className="filters">
              <label>
                Assessment
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All assessments ({rows.length})</option>
                  {Object.entries(outcomes).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Review status
                <select
                  value={reviewFilter}
                  onChange={(e) => setReviewFilter(e.target.value)}
                >
                  <option value="all">All review statuses</option>
                  {[
                    "Pending review",
                    "Evidence requested",
                    "Accepted",
                    "Dismissed",
                  ].map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </label>
              <label>
                Source severity
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                >
                  <option value="all">All severities</option>
                  {["high", "medium", "low", "unknown"].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {results.isLoading ? (
              <Busy />
            ) : results.error ? (
              <ErrorNote text={message(results.error)} />
            ) : displayed.length ? (
              displayed.map((r) => (
                <button
                  key={r.id}
                  className={
                    "file-row assessment " +
                    (selected?.id === r.id ? "chosen" : "")
                  }
                  aria-controls={`assessment-detail-${r.id}`}
                  onClick={() => {
                    if (selected?.id === r.id) {
                      revealAssessment(r.id);
                    } else {
                      go(run.id, r.id);
                    }
                  }}
                >
                  <span className="doc-icon inspection">
                    <ScanLine size={19} />
                  </span>
                  <span className="row-main">
                    <b>{r.claim.source.quote}</b>
                    <small>
                      {r.claim.source.document} · page {r.claim.source.page} ·{" "}
                      {reviewStatus(r)}
                    </small>
                  </span>
                  <Tag tone={tone[r.outcome]}>{outcomes[r.outcome]}</Tag>
                  <ArrowRight size={16} />
                </button>
              ))
            ) : (
              <p className="empty-text">
                {rows.length
                  ? "No assessments match the current filters."
                  : "No citable statements were published for this snapshot. Check coverage before interpreting the result."}
              </p>
            )}
          </>
        )}
      </section>
      {displayed.map((row) => (
        <Detail
          key={row.id}
          r={row}
          token={token}
          writable={writable}
          preview={preview}
          saved={() => void results.refetch()}
        />
      ))}
      {printData && <PrintSheet dossier={d} report={printData} />}
    </>
  );
}
function Detail({
  r,
  token,
  writable,
  preview,
  saved,
}: {
  r: Result;
  token: string;
  writable: boolean;
  preview: (p: Preview) => void;
  saved: () => void;
}) {
  const [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function record(action: Action) {
    setBusy(true);
    setError("");
    try {
      await api("/v1/results/" + r.id + "/reviews", token, "POST", {
        action,
        comment: note,
      });
      setNote("");
      saved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel"
      id={`assessment-detail-${r.id}`}
      aria-label={`Source comparison: ${r.claim.source.quote}`}
      tabIndex={-1}
      style={{ scrollMarginTop: "1.5rem" }}
    >
      <div className="section-head">
        <div>
          <h2>Source comparison</h2>
          <p>{r.reason}</p>
        </div>
        <Tag tone={tone[r.outcome]}>{outcomes[r.outcome]}</Tag>
      </div>
      <div className="comparison">
        {citation(r.claim.source, "Inspection statement", preview)}
        {r.evidence.length ? (
          r.evidence.map((ref, i) => (
            <div key={ref.chunk_id + "-" + i}>
              {citation(ref, "Retrieved evidence", preview)}
            </div>
          ))
        ) : (
          <div className="source-card">
            <h3>Retrieved evidence</h3>
            <p>
              No source quotation was published for this side of the comparison.
            </p>
          </div>
        )}
      </div>
      <details className="coverage">
        <summary><span>Evidence coverage and verification checks</span></summary>
        <p className="coverage-summary">
          {r.coverage.full_search
            ? "Complete secondary search performed."
            : "Assessment used selected evidence passages."}{" "}
          {r.coverage.unreadable_pages} uncertain or unreadable pages.
        </p>
        <ul className="coverage-documents">
          {r.coverage.documents.map((v) => (
            <li key={v.version_id}>
              {v.document} · {v.readable}/{v.pages} readable pages
            </li>
          ))}
        </ul>
        <p className="coverage-checks">
          <span className="coverage-check">
            <b>Scope check</b><i>{r.checks.scope.replaceAll("_", " ")}</i>
          </span>
          <span className="coverage-check">
            <b>Second opinion</b>
            <i>{r.checks.secondary.replaceAll("_", " ")}</i>
          </span>
        </p>
      </details>
      <div className="review-actions">
        <h3>Reviewer record</h3>
        {r.reviews.length ? (
          r.reviews.map((ev) => (
            <div className="review-note" key={ev.id}>
              <b>{decisions[ev.action as Action] || ev.action}</b>
              <small>
                {dateText(ev.created_at)} · {ev.actor || "Deleted account"}
              </small>
              {ev.comment && <p>{ev.comment}</p>}
            </div>
          ))
        ) : (
          <p className="muted review-awaiting">Awaiting reviewer decision.</p>
        )}
        {writable && (
          <>
            <label>
              Review note
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={3000}
                rows={3}
                placeholder="Record the reason or evidence to request"
              />
            </label>
            {error && <ErrorNote text={error} />}
            <div className="inline-actions">
              {Object.entries(decisions).map(([key, label]) => (
                <button
                  className={`review-action review-action-${key}${key === "accept" ? " primary" : ""}`}
                  key={key}
                  disabled={
                    busy ||
                    (["request_evidence", "comment"].includes(key) &&
                      !note.trim())
                  }
                  onClick={() => void record(key as Action)}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
function PrintSheet({
  dossier: d,
  report,
}: {
  dossier: Dossier;
  report: PrintableReport;
}) {
  const { run, results: rows, cap_reviews: capReviews } = report;
  return (
    <article className="print-sheet">
      <h1>{d.case.title}</h1>
      <p>
        {d.case.factory} · {dateText(run.created_at)} · {run.status}
      </p>
      <p>
        Documentary evidence review. Physical safety and formal closure require
        the appropriate inspection authority.
      </p>
      <h2>Sources</h2>
      <ul>
        {run.manifest.map((v) => (
          <li key={v.id}>
            {v.title} · revision {v.revision} · {v.readable_pages}/
            {v.page_count} readable pages
          </li>
        ))}
      </ul>
      <p>
        {run.config.pipeline} · {run.config.llm} · {run.config.embedding}
      </p>
      {rows.map((r) => (
        <section className="print-result" key={r.id}>
          <h2>{outcomes[r.outcome]}</h2>
          <p className={`print-explanation print-${tone[r.outcome]}`}>
            {plainResult(r.outcome)}
          </p>
          <h3>Statement checked</h3>
          <blockquote dir="auto">
            {r.claim.source.quote}
            <small>
              {r.claim.source.document} · revision {r.claim.source.revision} ·
              page {r.claim.source.page}
            </small>
          </blockquote>
          {r.evidence.length > 0 ? (
            <>
              <h3>Evidence found</h3>
              {r.evidence.map((q, i) => (
                <blockquote key={i} dir="auto">
                  {q.quote}
                  <small>
                    {q.document} · revision {q.revision} · page {q.page}
                  </small>
                </blockquote>
              ))}
            </>
          ) : (
            <p>No source passage was cited for this result.</p>
          )}
          <p>
            Search checked: {" "}
            {r.coverage.full_search
              ? "all readable pages in the selected records"
              : "the most relevant passages"}
            {r.coverage.unreadable_pages > 0
              ? `; ${r.coverage.unreadable_pages} pages could not be read`
              : ""}.
          </p>
          {r.reviews.map((e) => (
            <p key={e.id}>
              {e.action} · {dateText(e.created_at)} · {e.actor || "Deleted account"} {e.comment}
            </p>
          ))}
        </section>
      ))}
      {run.cap_analysis && (
        <section>
          <h2>Corrective Action Plan review</h2>
          <p>
            {run.cap_analysis.coverage.complete
              ? "CAP actions extracted from the listed source versions."
              : "Incomplete CAP extraction coverage."}
          </p>
          {run.cap_analysis.actions.map((action) => (
            <div key={action.id}>
              <blockquote dir="auto">
                {action.source.quote}
                <small>
                  {action.source.document} · page {action.source.page}
                </small>
              </blockquote>
              {capReviews
                .filter((event) => event.action_id === action.id)
                .map((event) => (
                  <p key={event.id}>
                    Link{" "}
                    {event.decision === "confirm" ? "confirmed" : "dismissed"} ·{" "}
                    {dateText(event.created_at)} ·{" "}
                    {
                      rows.find((row) => row.id === event.finding_id)?.claim
                        .source.quote
                    }{" "}
                    {event.comment}
                  </p>
                ))}
            </div>
          ))}
        </section>
      )}
    </article>
  );
}
