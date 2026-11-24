"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckSquare, FileText, Link2 } from "lucide-react";
import { api, dateText, message } from "@/lib/api";
import type {
  CapAction,
  CapAnalysis,
  CapReview,
  Dossier,
  Ref,
  Result,
} from "@/lib/api";
import { reviewableRuns } from "@/lib/review";
import { Busy, ErrorNote, Tag } from "./ui";
import type { Preview } from "./viewer";

type Props = {
  dossier: Dossier;
  token: string;
  preview: (p: Preview) => void;
  documents: () => void;
  review: (run: string, result: string) => void;
};

function ReferenceText({ text }: { text: string }) {
  return text.split(/\b((?:CA|FI)[-\u2011\u2013/]\d+)\b/gi).map((part, index) =>
    index % 2 ? (
      <mark
        key={index}
        className={`reference-id ${part.toUpperCase().startsWith("CA") ? "cap-reference" : "finding-reference"}`}
      >
        {part}
      </mark>
    ) : part,
  );
}

export function CapReview({
  dossier,
  token,
  preview,
  documents,
  review,
}: Props) {
  const available = reviewableRuns(dossier.runs).filter((run) =>
    run.manifest.some((doc) => doc.role === "cap"),
  );
  const [chosen, setChosen] = useState("");
  const run = available.find((item) => item.id === chosen) || available[0];
  const cap = useQuery({
    queryKey: ["cap", run?.id],
    queryFn: () =>
      api<{ analysis: CapAnalysis | null; reviews: CapReview[] }>(
        `/v1/runs/${run.id}/cap`,
        token,
      ),
    enabled: !!run,
  });
  const results = useQuery({
    queryKey: ["results", run?.id],
    queryFn: () => api<Result[]>(`/v1/runs/${run.id}/results`, token),
    enabled: !!run,
  });

  const findings =
    results.data?.filter((item) => item.claim.kind === "finding") || [];
  const analysis = cap.data?.analysis;
  const events = cap.data?.reviews || [];
  const writable =
    dossier.role === "reviewer" &&
    !dossier.case.archived &&
    !dossier.case.deleting;
  if (!run)
    return (
      <section className="panel blank">
        <span className="large-icon">
          <Link2 />
        </span>
        <h2>Corrective Action Plan</h2>
        <p>
          Add a PDF with the Corrective Action Plan (CAP) role, then include it
          with an inspection report in a verification run.
        </p>
        <button onClick={documents}>
          Open documents <ArrowRight size={15} />
        </button>
      </section>
    );
  if (cap.isLoading || results.isLoading)
    return <Busy text="Opening CAP review…" />;
  if (cap.error || results.error)
    return <ErrorNote text={message(cap.error || results.error)} />;
  if (!analysis)
    return (
      <section className="panel blank">
        <h2>CAP analysis unavailable for this run</h2>
        <button onClick={documents}>
          Open documents <ArrowRight size={15} />
        </button>
      </section>
    );

  function source(ref: Ref) {
    preview({ title: ref.document, version: ref.version_id, anchor: ref });
  }

  const pairKey = (link: { finding_id: string; action_id: string }) =>
    `${link.finding_id}/${link.action_id}`;
  const latestDecisions = new Map(
    events.map((event) => [pairKey(event), event]),
  );
  const linked = new Set(
    analysis.suggestions
      .filter(
        (suggestion) =>
          latestDecisions.get(pairKey(suggestion))?.decision !== "dismiss",
      )
      .map((suggestion) => suggestion.action_id),
  );
  for (const event of latestDecisions.values()) {
    if (event.decision === "confirm") linked.add(event.action_id);
  }

  return (
    <>
      <section className="panel">
        <div className="section-head">
          <div>
            <h2>Corrective Action Plan</h2>
            <p>
              Check whether the factory’s proposed actions address the
              inspection findings.
            </p>
            <div className="reference-legend">
              <span className="reference-id finding-reference">FI · Inspection finding</span>
              <span className="reference-id cap-reference">CA · Corrective action</span>
            </div>
          </div>
          <Tag tone={analysis.coverage.complete ? "green" : "amber"}>
            {analysis.coverage.complete
              ? "CAP extracted"
              : "Incomplete evidence"}
          </Tag>
        </div>
        <div className="cap-header">
          <label>
            Verification snapshot
            <select
              value={run.id}
              onChange={(event) => setChosen(event.target.value)}
            >
              {available.map((item) => (
                <option key={item.id} value={item.id}>
                  {dateText(item.created_at)} · {item.manifest.length} documents
                  · {item.id.slice(0, 6)}
                </option>
              ))}
            </select>
          </label>
          <div>
            <strong>{findings.length}</strong>
            <small>Inspection findings</small>
          </div>
          <div>
            <strong>{analysis.actions.length}</strong>
            <small>Extracted CAP actions</small>
          </div>
          <div>
            <strong>{analysis.actions.length - linked.size}</strong>
            <small>Actions without a link</small>
          </div>
        </div>
        {!analysis.coverage.complete && (
          <p className="empty-text">
            {analysis.error ||
              `Review the original CAP. ${analysis.coverage.unreadable_pages ?? 0} unreadable pages and ${analysis.coverage.unanchored_actions ?? 0} unavailable action citations.`}
          </p>
        )}
      </section>
      {findings.length === 0 && (
        <section className="panel">
          <p className="empty-text">
            No citable inspection findings were extracted for this run.
          </p>
        </section>
      )}
      {findings.map((finding) => (
        <FindingPanel
          key={run.id + finding.id}
          finding={finding}
          analysis={analysis}
          events={events}
          run={run.id}
          token={token}
          writable={writable}
          source={source}
          openResult={() => review(run.id, finding.id)}
          updated={() => void cap.refetch()}
        />
      ))}
      {analysis.actions.length > 0 && (
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>CAP action register</h2>
              <p>Dates and progress as reported in the source document.</p>
            </div>
          </div>
          {analysis.actions.map((action) => (
            <button
              className="file-row"
              key={action.id}
              onClick={() => source(action.source)}
            >
              <span className="doc-icon other">
                <FileText size={17} />
              </span>
              <span className="row-main">
                <b dir="auto"><ReferenceText text={action.source.quote} /></b>
                <small>
                  {action.source.document} · page {action.source.page}
                  {action.deadline ? ` · Due ${dateText(action.deadline)}` : ""}
                </small>
              </span>
              {!linked.has(action.id) && <Tag tone="amber">Without link</Tag>}
              <ArrowRight size={16} />
            </button>
          ))}
        </section>
      )}
    </>
  );
}

function FindingPanel({
  finding,
  analysis,
  events,
  run,
  token,
  writable,
  source,
  openResult,
  updated,
}: {
  finding: Result;
  analysis: CapAnalysis;
  events: CapReview[];
  run: string;
  token: string;
  writable: boolean;
  source: (ref: Ref) => void;
  openResult: () => void;
  updated: () => void;
}) {
  const [add, setAdd] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const suggestions = new Map(
    analysis.suggestions
      .filter((link) => link.finding_id === finding.id)
      .map((link) => [link.action_id, link]),
  );
  const history = events.filter((event) => event.finding_id === finding.id);
  const relevant = analysis.actions.filter(
    (action) =>
      suggestions.has(action.id) ||
      history.some((event) => event.action_id === action.id),
  );
  const unlinked = analysis.actions.filter(
    (action) => !relevant.some((item) => item.id === action.id),
  );

  async function decide(action: CapAction, decision: "confirm" | "dismiss") {
    setBusy(true);
    setError("");
    try {
      await api(`/v1/runs/${run}/cap/reviews`, token, "POST", {
        finding_id: finding.id,
        action_id: action.id,
        decision,
        comment: note,
      });
      setAdd("");
      setNote("");
      updated();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel cap-finding">
      <div className="section-head">
        <div>
          <h2 dir="auto"><ReferenceText text={finding.claim.source.quote} /></h2>
          <p>
            {finding.claim.source.document} · page {finding.claim.source.page}
          </p>
        </div>
        <button onClick={openResult}>
          Open finding <ArrowRight size={15} />
        </button>
      </div>
      {relevant.length === 0 && (
        <p className="empty-text">
          {analysis.coverage.complete
            ? "No CAP link found for this finding in the selected documents."
            : "Coverage is incomplete. Inspect the original CAP before concluding that there is no matching action."}
        </p>
      )}
      {relevant.map((action) => {
        const suggestion = suggestions.get(action.id);
        const newest = history.findLast(
          (event) => event.action_id === action.id,
        );
        return (
          <article className="cap-action" key={action.id}>
            <div className="inline-actions">
              <Link2 size={17} />
              <Tag
                tone={
                  newest?.decision === "confirm"
                    ? "green"
                    : suggestion?.basis === "explicit_reference_conflict"
                      ? "amber"
                      : ""
                }
              >
                {newest
                  ? newest.decision === "confirm"
                    ? "Link confirmed"
                    : "Link dismissed"
                  : suggestion?.basis === "explicit_reference_conflict"
                    ? "FI reference · check mismatch"
                  : suggestion?.basis === "explicit_reference"
                    ? "Explicit reference"
                    : "Possible match"}
              </Tag>
              {action.action_ref && <span className="reference-id cap-reference">{action.action_ref}</span>}
            </div>
            <blockquote dir="auto"><ReferenceText text={action.source.quote} /></blockquote>
            <p className="muted">
              {suggestion?.reason || "Link added by the reviewer."}
            </p>
            {action.deadline && <p>Target date: {dateText(action.deadline)}</p>}
            {action.reported_status && (
              <p>Status at submission (CAP): {action.reported_status}</p>
            )}
            {newest && (
              <p className="muted">
                Reviewed {dateText(newest.created_at)}
                {newest.comment ? ` · ${newest.comment}` : ""}
              </p>
            )}
            <div className="inline-actions">
              <button onClick={() => source(action.source)}>
                <FileText size={15} />
                Open CAP page {action.source.page}
              </button>
              {writable && newest?.decision !== "confirm" && (
                <button
                  disabled={busy}
                  onClick={() => void decide(action, "confirm")}
                >
                  <CheckSquare size={15} />
                  Confirm link
                </button>
              )}
              {writable && newest?.decision !== "dismiss" && (
                <button
                  disabled={busy}
                  onClick={() => void decide(action, "dismiss")}
                >
                  Dismiss link
                </button>
              )}
            </div>
          </article>
        );
      })}
      {writable && analysis.actions.length > 0 && (
        <div className="cap-controls">
          <label>
            Decision note
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={3000}
              placeholder="Optional note for your next link decision"
            />
          </label>
          {unlinked.length > 0 && (
            <div className="inline-actions">
              <label>
                Add a manual link
                <select
                  value={add}
                  onChange={(event) => setAdd(event.target.value)}
                >
                  <option value="">Select a CAP action</option>
                  {unlinked.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.action_ref || item.source.document} ·{" "}
                      {item.reported_status
                        ? `${item.reported_status.charAt(0).toUpperCase()}${item.reported_status.slice(1)} (CAP)`
                        : "CAP status unavailable"} ·{" "}
                      {item.source.quote.replace(/\s+/g, " ").slice(0, 90)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!add || busy}
                onClick={() => {
                  const target = unlinked.find((item) => item.id === add);
                  if (target) void decide(target, "confirm");
                }}
              >
                Save link
              </button>
            </div>
          )}
        </div>
      )}
      {error && <ErrorNote text={error} />}
      {history.length > 0 && (
        <details className="coverage">
          <summary>Link decision history</summary>
          <ul>
            {history.map((event) => (
              <li key={event.id}>
                {event.decision === "confirm" ? "Confirmed" : "Dismissed"} ·{" "}
                {dateText(event.created_at)}
                {event.comment ? ` · ${event.comment}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
