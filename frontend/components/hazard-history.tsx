"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, dateText, message, type Ref } from "@/lib/api";
import { Busy, ErrorNote, Tag } from "./ui";
import type { Preview } from "./viewer";

const statusLabels = {
  opened: "Opened",
  carried_forward: "Carried forward",
  closed: "Closed",
  reopened: "Reopened",
  needs_review: "Conflicting location or asset · Needs review",
};

type Hazard = {
  finding_id: string;
  events: { date: string; source: Ref; status: keyof typeof statusLabels }[];
};

export function HazardHistory({ caseId, token, preview }: {
  caseId: string;
  token: string;
  preview: (item: Preview) => void;
}) {
  const [selected, setSelected] = useState("");
  const query = useQuery({
    queryKey: ["hazard-history", caseId, token],
    queryFn: () => api<Hazard[]>(`/v1/cases/${caseId}/hazard-history`, token),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const hazards = query.data ?? [];
  const current = hazards.find((hazard) => hazard.finding_id === selected) ?? hazards[0];

  return (
    <section className="panel" aria-labelledby="hazard-history-title">
      <div className="section-head">
        <div>
          <h2 id="hazard-history-title">Hazard history</h2>
          <p>Follow findings with a shared report ID across inspections in this series.</p>
        </div>
        <button onClick={() => void query.refetch()} disabled={query.isFetching}>
          Refresh
        </button>
      </div>
      {query.isPending ? <Busy text="Loading hazard history…" /> : query.error ? (
        <ErrorNote text={message(query.error)} />
      ) : !current ? (
        <p className="empty-text">Complete a verification run with a cited finding ID to see its history here.</p>
      ) : (
        <>
          {hazards.length > 1 && (
            <div className="filters">
              <label>
                Finding ID
                <select value={current.finding_id} onChange={(event) => setSelected(event.target.value)}>
                  {hazards.map(({ finding_id }) => <option key={finding_id}>{finding_id}</option>)}
                </select>
              </label>
            </div>
          )}
          <div className="section-head"><h3>{current.finding_id}</h3></div>
          <ol className="hazard-history-events">
            {current.events.map(({ date, source, status }) => (
              <li key={`${date}/${source.page_id}/${source.start}/${status}`}>
                <button className="file-row" onClick={() => preview({
                  version: source.version_id, title: source.document, anchor: source,
                })}>
                  <span className="row-main">
                    <b>{dateText(date)} · {source.document} · Page {source.page}</b>
                    <small dir="auto">{source.quote}</small>
                  </span>
                  <Tag tone={status === "closed" ? "green" : "amber"}>{statusLabels[status]}</Tag>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
