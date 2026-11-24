"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, History } from "lucide-react";
import type { Result, Run } from "@/lib/api";
import { api, message, outcomes } from "@/lib/api";
import { compareDocuments, compareResults, reviewableRuns } from "@/lib/review";
import { Busy, ErrorNote, Tag } from "./ui";

function runLabel(run: Run) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Dhaka",
  }).format(new Date(run.created_at));
}

export function RunHistory({
  runs,
  token,
  open,
}: {
  runs: Run[];
  token: string;
  open: (run: string, item?: string) => void;
}) {
  const eligible = reviewableRuns(runs);
  const [choice, setChoice] = useState({ older: "", newer: "" });
  const second = eligible.find((run) => run.id === choice.newer) || eligible[0];
  const olderRuns = second ? eligible.slice(eligible.indexOf(second) + 1) : [];
  const first =
    eligible.find((run) => run.id === choice.older) ||
    olderRuns.find((run) => compareDocuments(run, second).length > 0) ||
    olderRuns[0] ||
    eligible[1];
  const canCompare =
    !!first &&
    !!second &&
    first.id !== second.id &&
    first.created_at <= second.created_at;
  const before = useQuery({
    queryKey: ["results", first?.id],
    queryFn: () => api<Result[]>(`/v1/runs/${first.id}/results`, token),
    enabled: canCompare,
  });
  const after = useQuery({
    queryKey: ["results", second?.id],
    queryFn: () => api<Result[]>(`/v1/runs/${second.id}/results`, token),
    enabled: canCompare,
  });
  const diff =
    canCompare && before.data && after.data
      ? compareResults(first, second, before.data, after.data)
      : null;
  const files = canCompare ? compareDocuments(first, second) : [];
  return (
    <>
      {eligible.length >= 2 && (
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>Compare runs</h2>
              <p>
                See which source versions and documentary assessments changed.
              </p>
            </div>
          </div>
          <div className="filters two-up">
            <label>
              Earlier run
              <select
                value={first.id}
                onChange={(event) =>
                  setChoice({ ...choice, older: event.target.value })
                }
              >
                {eligible.map((run) => (
                  <option key={run.id} value={run.id}>
                    {runLabel(run)} · {run.manifest.length} documents ·{" "}
                    {run.id.slice(0, 6)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Later run
              <select
                value={second.id}
                onChange={(event) =>
                  setChoice({ ...choice, newer: event.target.value })
                }
              >
                {eligible.map((run) => (
                  <option key={run.id} value={run.id}>
                    {runLabel(run)} · {run.manifest.length} documents ·{" "}
                    {run.id.slice(0, 6)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!canCompare ? (
            <p className="empty-text">
              Select two different snapshots in date order.
            </p>
          ) : before.isLoading || after.isLoading ? (
            <Busy text="Comparing the saved snapshots…" />
          ) : before.error || after.error ? (
            <ErrorNote text={message(before.error || after.error)} />
          ) : (
            diff && (
              <>
                <div className="coverage">
                  <b>Document changes</b>
                  {files.length > 0 ? (
                    <ul>
                      {files.map((change) => (
                        <li key={change.id}>
                          {change.title} ·{" "}
                          {change.from === null
                            ? "Added to later run"
                            : change.to === null
                              ? "Absent from later run"
                              : `Revision ${change.from} → ${change.to}`}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>Both runs used the same document versions.</p>
                  )}
                  <p>
                    {diff.unchanged} source-matched assessments with the same
                    outcome. A missing assessment still needs reviewer
                    interpretation.
                  </p>
                </div>
                {diff.changes.length === 0 ? (
                  <p className="empty-text">
                    No assessment changes between these runs.
                  </p>
                ) : (
                  diff.changes.map(({ before: older, after: newer }) => {
                    const row = newer || older!;
                    return (
                      <button
                        key={row.id}
                        className="file-row assessment"
                        onClick={() =>
                          open(newer ? second.id : first.id, row.id)
                        }
                      >
                        <span className="doc-icon other">
                          <History size={17} />
                        </span>
                        <span className="row-main">
                          <b dir="auto">{row.claim.source.quote}</b>
                          <small>{row.claim.source.document}</small>
                        </span>
                        <Tag>
                          {older && newer
                            ? `${outcomes[older.outcome]} → ${outcomes[newer.outcome]}`
                            : newer
                              ? "Only in later run"
                              : "Only in earlier run"}
                        </Tag>
                        <ArrowRight size={16} />
                      </button>
                    );
                  })
                )}
              </>
            )
          )}
        </section>
      )}
      <section className="panel">
        <div className="section-head">
          <div>
            <h2>Run history</h2>
            <p>Each run retains the source versions and reviewer decisions.</p>
          </div>
        </div>
        {runs.length ? (
          runs.map((run) => (
            <button
              className="file-row"
              key={run.id}
              onClick={() => open(run.id)}
            >
              <span className="doc-icon other">
                <History size={18} />
              </span>
              <span className="row-main">
                <b>{runLabel(run)}</b>
                <small>
                  {run.manifest.length} document versions ·{" "}
                  {run.usage.claims ?? "—"} statements
                </small>
              </span>
              <Tag>{run.status}</Tag>
              <ArrowRight size={16} />
            </button>
          ))
        ) : (
          <p className="empty-text">Start a verification run from Documents.</p>
        )}
        {eligible.length === 1 && (
          <p className="empty-text">
            Complete a second run to compare evidence and assessments.
          </p>
        )}
      </section>
    </>
  );
}
