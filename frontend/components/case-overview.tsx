"use client";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ClipboardCheck,
  Files,
  History,
  ListChecks,
  MessageSquareMore,
  ScanLine,
} from "lucide-react";
import type { Dossier, FollowUp, Result } from "@/lib/api";
import { api, dateText, message, outcomes } from "@/lib/api";
import { reviewableRuns, reviewStatus } from "@/lib/review";
import { Busy, ErrorNote, Tag } from "./ui";

type Props = {
  dossier: Dossier;
  token: string;
  open: (
    view: "documents" | "review" | "history",
    run?: string,
    item?: string,
  ) => void;
};

export function CaseOverview({ dossier, token, open }: Props) {
  const latest = reviewableRuns(dossier.runs)[0];
  const results = useQuery({
    queryKey: ["results", latest?.id],
    queryFn: () => api<Result[]>(`/v1/runs/${latest.id}/results`, token),
    enabled: !!latest,
  });
  const rows = results.data || [];
  const attention = rows.filter(
    (row) =>
      row.outcome !== "supported" && reviewStatus(row) === "Pending review",
  );
  const requests = useQuery({
    queryKey: ["followups", dossier.case.id],
    queryFn: () =>
      api<FollowUp[]>(`/v1/cases/${dossier.case.id}/followups`, token),
  });
  const followups = requests.data || [];
  const ready = new Set(
    dossier.versions
      .filter((doc) => ["ready", "partial"].includes(doc.status))
      .map((doc) => doc.document_id),
  ).size;
  const active = dossier.jobs.filter((job) =>
    ["running", "queued"].includes(job.state),
  ).length;
  const interrupted = dossier.jobs.filter((job) =>
    ["failed", "paused"].includes(job.state),
  ).length;

  return (
    <>
      <div className="case-metrics" aria-label="Case activity">
        <button className="case-metric" onClick={() => open("documents")}>
          <Files size={19} />
          <strong>{ready}</strong>
          <span>Documents ready</span>
        </button>
        <button
          className="case-metric"
          onClick={() => open("review", latest?.id)}
        >
          <ListChecks size={19} />
          <strong>{results.isSuccess ? attention.length : "—"}</strong>
          <span>Flags to review</span>
        </button>
        <button
          className="case-metric"
          onClick={() =>
            document
              .getElementById("case-followups")
              ?.scrollIntoView({ block: "nearest" })
          }
        >
          <MessageSquareMore size={19} />
          <strong>{requests.isSuccess ? followups.length : "—"}</strong>
          <span>Evidence requested</span>
        </button>
        <button className="case-metric" onClick={() => open("history")}>
          <History size={19} />
          <strong>{dossier.runs.length}</strong>
          <span>Verification runs</span>
        </button>
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>Review priorities</h2>
              <p>
                {latest
                  ? `Latest review · ${dateText(latest.created_at)}`
                  : "Case activity"}
              </p>
            </div>
            {latest && (
              <button onClick={() => open("review", latest.id)}>
                Open review <ArrowRight size={15} />
              </button>
            )}
          </div>
          {active > 0 && (
            <Busy
              text={`${active} processing job${active === 1 ? "" : "s"} in progress…`}
            />
          )}
          {interrupted > 0 && (
            <div className="notice">
              <span>
                {interrupted} interrupted job{interrupted === 1 ? "" : "s"}.
              </span>
              <button onClick={() => open("documents")}>
                See processing activity
              </button>
            </div>
          )}
          {latest && results.isLoading ? (
            <Busy />
          ) : results.error ? (
            <ErrorNote text={message(results.error)} />
          ) : !latest ? (
            <div className="blank">
              <span className="large-icon">
                <ScanLine />
              </span>
              <h3>Ready for its first review</h3>
              <p>
                Add the inspection and supporting documents, then select which
                records to compare.
              </p>
              <button onClick={() => open("documents")}>
                Open documents <ArrowRight size={15} />
              </button>
            </div>
          ) : attention.length ? (
            attention.slice(0, 6).map((row) => (
              <button
                className="file-row"
                key={row.id}
                onClick={() => open("review", latest.id, row.id)}
              >
                <span className="doc-icon inspection">
                  <ClipboardCheck size={18} />
                </span>
                <span className="row-main">
                  <b dir="auto">{row.claim.source.quote}</b>
                  <small>
                    {row.claim.source.document} · page {row.claim.source.page}
                  </small>
                </span>
                <Tag tone={row.outcome === "contradicted" ? "red" : "amber"}>
                  {outcomes[row.outcome]}
                </Tag>
                <ArrowRight size={16} />
              </button>
            ))
          ) : (
            <p className="empty-text">
              No pending flags in this snapshot. Check open evidence requests
              for follow-up.
            </p>
          )}
        </section>
        <section className="panel" id="case-followups">
          <div className="section-head">
            <div>
              <h2>Evidence follow-up</h2>
              <p>
                {latest
                  ? "Open reviewer requests across this case"
                  : "Reviewer requests will appear here"}
              </p>
            </div>
          </div>
          {requests.isLoading ? (
            <Busy />
          ) : requests.error ? (
            <ErrorNote text={message(requests.error)} />
          ) : followups.length > 0 ? (
            followups.map((row) => (
              <button
                key={row.id}
                className="file-row"
                onClick={() => open("review", row.run_id, row.id)}
              >
                <span className="doc-icon other">
                  <MessageSquareMore size={17} />
                </span>
                <span className="row-main">
                  <b dir="auto">{row.event.comment}</b>
                  <small>
                    {row.source.document} · page {row.source.page} ·{" "}
                    {dateText(row.event.created_at)}
                  </small>
                </span>
                <ArrowRight size={15} />
              </button>
            ))
          ) : (
            <p className="empty-text">No open evidence requests.</p>
          )}
          {followups.length > 0 && (
            <div className="panel-pad">
              <button onClick={() => open("documents")}>
                Add supporting records <ArrowRight size={15} />
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
