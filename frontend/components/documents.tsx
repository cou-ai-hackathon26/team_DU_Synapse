"use client";
import { FormEvent, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ChevronRight,
  FileSearch,
  History,
  Play,
  Plus,
  RefreshCw,
  ScanLine,
  Trash2,
  UploadCloud,
} from "lucide-react";
import {
  api,
  dateText,
  Doc,
  Dossier,
  Job,
  PageInfo,
  Role,
  Version,
  message,
  roles,
} from "@/lib/api";
import type { components } from "@/lib/schema";
import { Busy, DocIcon, ErrorNote, Modal, Tag } from "./ui";
import { Preview } from "./viewer";
import { sampleCatalog } from "@/lib/samples";
import {
  documentsForMonth,
  inspectionMonths,
  latestReadyVersions,
} from "@/lib/verification-month";

type Props = {
  dossier: Dossier;
  token: string;
  configured: boolean;
  preview: (p: Preview) => void;
  refresh: () => Promise<void>;
  openedRun: (id: string) => void;
  onRemoved: () => void;
  owner: boolean;
};
const processed = (v: Version) =>
  v.status === "ready" || v.status === "partial";
function latest(versions: Version[]) {
  return latestReadyVersions(versions).map((v) => v.id);
}

export function Documents({
  dossier: d,
  token,
  configured,
  preview,
  refresh,
  openedRun,
  onRemoved,
  owner,
}: Props) {
  const writable =
    d.role === "reviewer" && !d.case.archived && !d.case.deleting;
  const [upload, setUpload] = useState(false),
    [inspect, setInspect] = useState<Version | null>(null),
    [remove, setRemove] = useState(false),
    [removeDocument, setRemoveDocument] = useState<Doc | null>(null);
  const [err, setErr] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string[]>(() => latest(d.versions)),
    [custom, setCustom] = useState(false);
  const [month, setMonth] = useState("");
  const [selectionOpen, setSelectionOpen] = useState(false);
  const versionKey = d.versions.map((v) => v.id + v.status).join(",");
  useEffect(() => {
    if (!custom)
      setSelected(
        month
          ? documentsForMonth(
              d.documents,
              d.versions,
              month,
              d.case.inspection_on,
              d.prior_case_ids,
            )
          : latest(d.versions),
      );
  }, [
    versionKey,
    custom,
    month,
    d.documents,
    d.versions,
    d.case.inspection_on,
  ]);
  function toggle(v: Version) {
    setCustom(true);
    setSelected((prev) =>
      prev.includes(v.id)
        ? prev.filter((id) => id !== v.id)
        : [
            ...prev.filter(
              (id) =>
                d.versions.find((x) => x.id === id)?.document_id !==
                v.document_id,
            ),
            v.id,
          ],
    );
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function chooseMonth(value: string) {
    setMonth(value);
    setCustom(false);
    setSelectionOpen(true);
    setBusy(true);
    setErr("");
    try {
      await refresh();
    } catch (error) {
      setErr(message(error));
    } finally {
      setBusy(false);
    }
  }
  const sel = d.versions.filter((v) => selected.includes(v.id)),
    count = sel.reduce((a, v) => a + v.readable_pages, 0),
    pages = sel.reduce((a, v) => a + v.page_count, 0);
  const hasInspection = sel.some(
    (v) =>
      d.documents.find((doc) => doc.id === v.document_id)?.role ===
      "inspection",
  );
  const hasMonthInspection =
    !month ||
    sel.some((v) => {
      if (
        d.documents.find((doc) => doc.id === v.document_id)?.role !==
        "inspection"
      )
        return false;
      const from = (v.period_start || v.period_end || v.issued_on)?.slice(0, 7);
      const to = (v.period_end || v.period_start || v.issued_on)?.slice(0, 7);
      return !!from && !!to && from <= month && to >= month;
    });
  const valid =
    sel.length >= 2 && sel.length <= 10 && hasInspection && hasMonthInspection;
  const availableIds = new Set(latest(d.versions));
  const months = inspectionMonths(d.documents, d.versions);
  const choices = d.versions.filter(
    (v) => selected.includes(v.id) || availableIds.has(v.id),
  );
  async function run() {
    await act(async () => {
      const r = await api<components["schemas"]["RunTicket"]>(
        "/v1/cases/" + d.case.id + "/runs",
        token,
        "POST",
        { version_ids: selected, request_key: crypto.randomUUID() },
      );
      openedRun(r.run_id);
    });
  }
  return (
    <>
      <div className="work-grid">
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>Case documents</h2>
              <p>
                {d.case.inspection_on
                  ? "Upload the inspection report here. The factory manager submits CAPs, incident records and other factory evidence."
                  : "Select the versions to include in this review."}
              </p>
            </div>
            {writable && (
              <button onClick={() => setUpload(true)}>
                <Plus size={15} />
                Add PDF
              </button>
            )}
          </div>
          {d.versions.length === 0 ? (
            <div className="blank">
              <div className="large-icon">
                <UploadCloud />
              </div>
              <h3>Add your first documents</h3>
              <p>
                {d.case.inspection_on
                  ? "Upload your inspection report to make it available to the factory manager."
                  : "Upload an inspection report and the records you want to compare."}
              </p>
              {writable && (
                <button onClick={() => setUpload(true)}>Choose PDF</button>
              )}
            </div>
          ) : (
            d.versions.map((v) => {
              const doc = d.documents.find((x) => x.id === v.document_id)!;
              return (
                <div className="version-row" key={v.id}>
                  <input
                    type="checkbox"
                    aria-label={
                      "Include " + doc.title + " revision " + v.revision
                    }
                    disabled={!writable || !processed(v)}
                    checked={selected.includes(v.id)}
                    onChange={() => toggle(v)}
                  />
                  <DocIcon role={doc.role} />
                  <div className="row-main">
                    <b>{doc.title}</b>
                    <small>
                      {roles[doc.role]} · Revision {v.revision} · {v.filename}
                    </small>
                    <small>
                      {doc.source_case_title
                        ? `Earlier inspection · ${doc.source_case_title}`
                        : `Factory · ${d.case.factory}`}
                    </small>
                    <div className="row-meta">
                      <Tag
                        tone={
                          v.status === "ready"
                            ? "green"
                            : v.status === "partial"
                              ? "amber"
                              : "neutral"
                        }
                      >
                        {v.status.replaceAll("_", " ")}
                      </Tag>
                      {processed(v) && (
                        <small>
                          {v.readable_pages}/{v.page_count} readable pages
                        </small>
                      )}
                    </div>
                    {v.error && <small className="error-text">{v.error}</small>}
                    {v.cap_deadline_warning && (
                      <p className="deadline-warning" role="alert">
                        CAP deadline flag: {v.cap_deadline_warning}
                      </p>
                    )}
                    {v.duplicate_warning && (
                      <p className="callout duplicate-warning" role="status">
                        Possible duplicate: {v.duplicate_warning}
                      </p>
                    )}
                  </div>
                  {processed(v) && (
                    <button
                      className="icon-button"
                      aria-label={"Inspect " + doc.title}
                      onClick={() => setInspect(v)}
                    >
                      <FileSearch size={18} />
                    </button>
                  )}
                  {d.role === "manager" &&
                    v.revision ===
                      Math.max(
                        ...d.versions
                          .filter((item) => item.document_id === doc.id)
                          .map((item) => item.revision),
                      ) && (
                      <button
                        className="icon-button danger-icon"
                        aria-label={`Delete ${doc.title}`}
                        title="Delete document"
                        disabled={busy}
                        onClick={() => {
                          setErr("");
                          setRemoveDocument(doc);
                        }}
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                </div>
              );
            })
          )}
          {writable &&
            !d.case.inspection_on &&
            d.case.factory === sampleCatalog.factory &&
            d.documents.length < sampleCatalog.documents.length && (
              <div className="panel-pad">
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api("/v1/cases/" + d.case.id + "/samples", token, "POST"),
                    )
                  }
                >
                  Load sample documents
                </button>
              </div>
            )}
        </section>
        <aside className="panel run-card">
          <span className="large-icon">
            <ScanLine />
          </span>
          <h2>Verify evidence</h2>
          <p>
            Compare the selected records and review the source passage behind
            each flag.
          </p>
          <div className="verification-month">
            <label htmlFor="verification-month">Verification month</label>
            <select
              id="verification-month"
              value={month}
              disabled={!writable || busy || months.length === 0}
              onChange={(event) => void chooseMonth(event.target.value)}
            >
              <option value="">
                {months.length
                  ? "Choose inspection month"
                  : "No inspection months available"}
              </option>
              {months.map((value) => (
                <option key={value} value={value}>
                  {new Intl.DateTimeFormat("en", {
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC",
                  }).format(new Date(`${value}-01T00:00:00Z`))}
                </option>
              ))}
            </select>
          </div>
          <p className="hint">
            Only months covered by a processed inspection report are available.
          </p>
          {month && (
            <p className="hint">
              Includes this month’s records and ready documents from earlier
              inspections in this follow-up series. Check for missing records
              and adjust the selection below.
            </p>
          )}
          <details
            className="verification-selection"
            open={selectionOpen}
            onToggle={(event) => setSelectionOpen(event.currentTarget.open)}
          >
            <summary>
              Documents to verify ({sel.length}){custom ? " · adjusted" : ""}
            </summary>
            <div className="verification-choices">
              {choices.length ? (
                choices.map((v) => {
                  const doc = d.documents.find(
                    (item) => item.id === v.document_id,
                  )!;
                  return (
                    <label key={v.id} className="verification-choice">
                      <input
                        type="checkbox"
                        aria-label={`Verify ${doc.title} revision ${v.revision}`}
                        checked={selected.includes(v.id)}
                        disabled={!writable || busy}
                        onChange={() => toggle(v)}
                      />
                      <span>
                        <b>{doc.title}</b>
                        <small>
                          {roles[doc.role]} · Revision {v.revision}
                        </small>
                        {doc.source_case_title && (
                          <small>Earlier inspection · {doc.source_case_title}</small>
                        )}
                        <small>
                          {v.period_start || v.issued_on || "Date not provided"}
                          {v.period_end && v.period_end !== v.period_start
                            ? ` – ${v.period_end}`
                            : ""}
                        </small>
                      </span>
                    </label>
                  );
                })
              ) : (
                <p>No processed documents are available yet.</p>
              )}
            </div>
            {month && (
              <button
                disabled={!writable || busy}
                onClick={() => void chooseMonth(month)}
              >
                {custom ? "Restore month selection" : "Refresh month selection"}
              </button>
            )}
          </details>
          <dl>
            <div>
              <dt>Selected documents</dt>
              <dd>{sel.length}</dd>
            </div>
            <div>
              <dt>Readable pages</dt>
              <dd>
                {count} / {pages}
              </dd>
            </div>
          </dl>
          {pages > count && (
            <p className="callout">
              Coverage is incomplete. Missing-evidence checks may require
              review.
            </p>
          )}
          {!configured && (
            <p className="callout">
              Hosted verification is waiting for the server’s Gemini key.
            </p>
          )}
          {!valid && (
            <p className="hint">
              {!hasMonthInspection
                ? "Add or select an inspection report covering this month."
                : sel.length > 10
                  ? "Select up to 10 documents for one verification run."
                  : "Select an inspection and at least one other document."}
            </p>
          )}
          {writable && (
            <button
              className="primary block"
              disabled={!configured || !valid || busy}
              onClick={run}
            >
              <Play size={15} />
              Run verification
            </button>
          )}
        </aside>
      </div>
      {err && <ErrorNote text={err} />}
      {d.jobs.some((j) => j.state !== "done") && (
        <section className="panel">
          <div className="section-head">
            <h2>Processing activity</h2>
          </div>
          {d.jobs
            .filter((j) => j.state !== "done")
            .map((j) => (
              <JobRow
                key={j.id}
                job={j}
                retry={
                  writable
                    ? () =>
                        void act(() =>
                          api("/v1/jobs/" + j.id + "/retry", token, "POST"),
                        )
                    : undefined
                }
              />
            ))}
        </section>
      )}
      {owner && (
        <details className="case-options">
          <summary>Case settings</summary>
          <div>
            <button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api("/v1/cases/" + d.case.id, token, "PATCH", {
                    archived: !d.case.archived,
                  }),
                )
              }
            >
              <Archive size={15} />
              {d.case.archived ? "Restore case" : "Archive case"}
            </button>
            <button onClick={() => setRemove(true)}>
              <Trash2 size={15} />
              Delete case
            </button>
          </div>
        </details>
      )}
      {remove && (
        <Modal title="Delete this case?" close={() => setRemove(false)}>
          <p>
            All original files, extractions, runs and review decisions in{" "}
            {d.case.title} will be permanently removed.
          </p>
          {err && <ErrorNote text={err} />}
          <div className="form-actions">
            <button onClick={() => setRemove(false)}>Keep case</button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/v1/cases/" + d.case.id, token, "DELETE");
                  onRemoved();
                } catch (e) {
                  setErr(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete case
            </button>
          </div>
        </Modal>
      )}
      {removeDocument && (
        <Modal
          title="Delete this document?"
          close={() => {
            if (!busy) setRemoveDocument(null);
          }}
        >
          <p>
            <b>{removeDocument.title}</b> and all its revisions will be removed
            from this case. Previous verification history will remain available.
          </p>
          {err && <ErrorNote text={err} />}
          <div className="form-actions">
            <button disabled={busy} onClick={() => setRemoveDocument(null)}>
              Keep document
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr("");
                try {
                  await api(
                    `/v1/cases/${d.case.id}/documents/${removeDocument.id}`,
                    token,
                    "DELETE",
                  );
                  setRemoveDocument(null);
                  await refresh();
                } catch (error) {
                  setErr(message(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete document
            </button>
          </div>
        </Modal>
      )}
      {upload && (
        <Upload
          dossier={d}
          token={token}
          close={() => setUpload(false)}
          done={async () => {
            setUpload(false);
            await refresh();
          }}
        />
      )}
      {inspect && (
        <Inspect
          version={inspect}
          token={token}
          title={
            d.documents.find((x) => x.id === inspect.document_id)?.title ||
            inspect.filename
          }
          close={() => setInspect(null)}
          preview={preview}
        />
      )}
    </>
  );
}

export function JobRow({ job: j, retry }: { job: Job; retry?: () => void }) {
  return (
    <div className="file-row">
      <span className="doc-icon other">
        <History size={17} />
      </span>
      <span className="row-main">
        <b>{j.stage}</b>
        <small>
          {j.error || j.kind}{" "}
          {j.total > 0 && " · " + j.completed + "/" + j.total}
        </small>
      </span>
      <Tag tone={["failed", "paused"].includes(j.state) ? "amber" : ""}>
        {j.state}
      </Tag>
      {retry && ["failed", "paused"].includes(j.state) && (
        <button onClick={retry}>
          <RefreshCw size={13} />
          Retry
        </button>
      )}
    </div>
  );
}

function pageHeader(text: string) {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean) || "Header unavailable"
  );
}

function clusterPagesByHeader(pages: PageInfo[]) {
  const clusters = new Map<string, { header: string; pages: PageInfo[] }>();
  for (const page of pages) {
    const header = pageHeader(page.text);
    const key = header.toLocaleLowerCase();
    const cluster = clusters.get(key) ?? { header, pages: [] };
    cluster.pages.push(page);
    clusters.set(key, cluster);
  }
  return [...clusters.values()];
}

function renderDocumentText(text: string) {
  const markers = /(\b(?:FI|CA|EX|E)-?\d{1,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:critical|high|immediate|overdue|missing|contradiction|unsupported|obstructed|injur\w*|fire|open|closed|in progress|completed|failed|blocked)\b)/gi;
  const sectionHeading = /^(?:visit details|inspection scope|scope and basis|review conditions|reading this report|inspection findings|findings|corrective actions?|evidence|incident details|summary|recommendations|follow-up|fire safety|electrical safety|building details|worker interviews|records reviewed)$/i;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const isHeading = sectionHeading.test(line);
      const isFinding = /^\s*(?:(?:finding|observation)\s*(?:id\s*)?(?:FI[-\s]*)?\d+\b|FI[-\s]*\d+\b)/i.test(line);
      const labelMatch = line.match(/^([^:]{2,42}:)(.*)$/);
      const parts = (labelMatch ? labelMatch[2] : line).split(markers);
      return (
        <div
          className={`document-text-line${isFinding ? " document-text-finding" : ""}${isHeading ? " document-text-heading" : ""}`}
          key={`${index}-${line.slice(0, 24)}`}
        >
          {labelMatch && <span className="document-text-label">{labelMatch[1]}</span>}
          {parts.map((part, partIndex) => {
            if (!part) return null;
            if (/^\d{4}-\d{2}-\d{2}$/.test(part)) {
              return <span className="document-token-date" key={partIndex}>{part}</span>;
            }
            if (/^(?:FI|CA|EX|E)-?\d{1,4}$/i.test(part)) {
              return <span className="document-token-reference" key={partIndex}>{part}</span>;
            }
            if (/^(?:critical|high|immediate|overdue|missing|contradiction|unsupported|obstructed|injur\w*|fire|failed|blocked)$/i.test(part)) {
              return <span className="document-token-alert" key={partIndex}>{part}</span>;
            }
            if (/^(?:open|closed|in progress|completed)$/i.test(part)) {
              return <span className="document-token-status" key={partIndex}>{part}</span>;
            }
            return part;
          })}
        </div>
      );
    });
}

function Inspect({
  version: v,
  title,
  token,
  close,
  preview,
}: {
  version: Version;
  title: string;
  token: string;
  close: () => void;
  preview: (p: Preview) => void;
}) {
  const q = useQuery({
    queryKey: ["pages", v.id],
    queryFn: () => api<PageInfo[]>(`/v1/document-versions/${v.id}/pages`, token),
  });
  const clusters = clusterPagesByHeader(q.data ?? []);
  return (
    <Modal title={title} close={close} className="inspection-text-modal">
      <div className="inline-actions">
        <Tag>Revision {v.revision}</Tag>
        <button
          onClick={() => {
            close();
            preview({ version: v.id, title });
          }}
        >
          Open original PDF <ChevronRight size={14} />
        </button>
      </div>
      {v.cap_deadline_warning && (
        <p className="deadline-warning" role="alert">
          CAP deadline flag: {v.cap_deadline_warning}
        </p>
      )}
      {v.duplicate_warning && (
        <p className="callout duplicate-warning" role="status">
          Possible duplicate: {v.duplicate_warning}
        </p>
      )}
      <div className="document-text-legend" aria-label="Text highlight key">
        <span className="document-finding-key">Finding</span>
        <span className="document-token-date">Dates</span>
        <span className="document-token-reference">Finding / CAP IDs</span>
        <span className="document-token-alert">Important risk</span>
        <span className="document-token-status">Status</span>
      </div>
      {q.isLoading ? (
        <Busy />
      ) : q.error ? (
        <ErrorNote text={message(q.error)} />
      ) : (
        clusters.map((cluster, index) => (
          <details
            className="page-text header-cluster"
            key={`${cluster.header}-${index}`}
            open={clusters.length === 1}
          >
            <summary className="header-cluster-title">
              <span>{cluster.header}</span>
              <small>{cluster.pages.length} {cluster.pages.length === 1 ? "page" : "pages"}</small>
            </summary>
            <div className="header-cluster-pages">
              {cluster.pages.map((page) => (
                <section className="header-cluster-page" key={page.id}>
                  <h3>
                    Page {page.page_no} · {page.method === "ocr" ? "OCR" : "Digital text"} · {page.quality}
                  </h3>
                  <div className="document-text-content">
                    {page.text ? renderDocumentText(page.text) : "No readable text."}
                  </div>
                </section>
              ))}
            </div>
          </details>
        ))
      )}
    </Modal>
  );
}

export function FactoryDocuments({
  dossier: d,
  token,
  preview,
  refresh,
}: {
  dossier: Dossier;
  token: string;
  preview: (item: Preview) => void;
  refresh: () => Promise<void>;
}) {
  const [upload, setUpload] = useState(false);
  const [inspect, setInspect] = useState<{ version: Version; title: string } | null>(null);
  const [removeDocument, setRemoveDocument] = useState<Doc | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [removing, setRemoving] = useState(false);
  const reports = d.versions.filter((version) =>
    d.documents.some(
      (doc) => doc.id === version.document_id && doc.role === "inspection",
    ),
  );
  const ready = reports.some(processed);
  const canUpload = ready && !d.case.archived && !d.case.deleting;
  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <h2>Inspection and factory documents</h2>
          <p>
            {ready
              ? "Read the inspection report before preparing the CAP and supporting records."
              : "The reviewer’s report will appear here when it is ready."}
          </p>
        </div>
        {canUpload && (
          <button className="primary" onClick={() => setUpload(true)}>
            <Plus size={16} /> Submit factory PDF
          </button>
        )}
      </div>
      {d.versions.map((version) => {
        const doc = d.documents.find((item) => item.id === version.document_id);
        if (!doc) return null;
        return (
          <div className="admin-row" key={version.id}>
            <div>
              <strong>{doc.title}</strong>
              <small>
                {roles[doc.role]} ·{" "}
                {version.issued_on
                  ? dateText(version.issued_on)
                  : "Date not entered"}{" "}
                · Revision {version.revision}
              </small>
              <small>
                {doc.role === "inspection" ? "From reviewer" : "From factory"}
              </small>
              {version.error && (
                <small className="error-text">{version.error}</small>
              )}
              {version.cap_deadline_warning && (
                <p className="deadline-warning" role="alert">
                  CAP deadline flag: {version.cap_deadline_warning}
                </p>
              )}
              {version.duplicate_warning && (
                <p className="callout duplicate-warning" role="status">
                  Possible duplicate: {version.duplicate_warning}
                </p>
              )}
            </div>
            <div className="document-row-actions">
              {processed(version) ? (
                <button
                  onClick={() => setInspect({ version, title: doc.title })}
                >
                  Open report
                </button>
              ) : (
                <Tag>{version.status.replaceAll("_", " ")}</Tag>
              )}
              {d.role === "manager" &&
                version.revision ===
                  Math.max(
                    ...d.versions
                      .filter((item) => item.document_id === doc.id)
                      .map((item) => item.revision),
                  ) && (
                  <button
                    className="danger"
                    onClick={() => {
                      setRemoveError("");
                      setRemoveDocument(doc);
                    }}
                  >
                    <Trash2 size={15} /> Delete
                  </button>
                )}
            </div>
          </div>
        );
      })}
      {upload && (
        <Upload
          dossier={d}
          token={token}
          close={() => setUpload(false)}
          done={async () => {
            setUpload(false);
            await refresh();
          }}
        />
      )}
      {inspect && (
        <Inspect
          version={inspect.version}
          title={inspect.title}
          token={token}
          close={() => setInspect(null)}
          preview={preview}
        />
      )}
      {removeDocument && (
        <Modal
          title="Delete this document?"
          close={() => {
            if (!removing) setRemoveDocument(null);
          }}
        >
          <p>
            <b>{removeDocument.title}</b> and all its revisions will be removed
            from this case. Previous verification history will remain available.
          </p>
          {removeError && <ErrorNote text={removeError} />}
          <div className="form-actions">
            <button disabled={removing} onClick={() => setRemoveDocument(null)}>
              Keep document
            </button>
            <button
              className="danger"
              disabled={removing}
              onClick={async () => {
                setRemoving(true);
                setRemoveError("");
                try {
                  await api(
                    `/v1/cases/${d.case.id}/documents/${removeDocument.id}`,
                    token,
                    "DELETE",
                  );
                  setRemoveDocument(null);
                  await refresh();
                } catch (error) {
                  setRemoveError(message(error));
                } finally {
                  setRemoving(false);
                }
              }}
            >
              Delete document
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Upload({
  dossier: d,
  token,
  close,
  done,
}: {
  dossier: Dossier;
  token: string;
  close: () => void;
  done: () => Promise<void>;
}) {
  type ExtractedMetadata = {
    title: string | null;
    role: Role;
    issued_on: string | null;
    inspection_date: string | null;
    period_start: string | null;
    period_end: string | null;
    issuer: string;
    warnings: string[];
    pages_checked: number;
    readable_pages: number;
    content_check:
      | "valid"
      | "invalid"
      | "uncertain"
      | "unavailable"
      | "not_configured"
      | "unreadable"
      | "not_applicable";
    content_reason: string | null;
    content_indicators: string[];
    content_model: string | null;
    cap_submission_deadline: string | null;
    cap_deadline_warning: string | null;
    content_fingerprint: string | null;
    duplicate_of: string | null;
    duplicate_warning: string | null;
  };
  const existingCap = d.documents.find((item) => item.role === "cap");
  const [err, setErr] = useState(""),
    [busy, setBusy] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [title, setTitle] = useState(""),
    [issuer, setIssuer] = useState("unknown"),
    [issuedOn, setIssuedOn] = useState(""),
    [periodStart, setPeriodStart] = useState(""),
    [periodEnd, setPeriodEnd] = useState(""),
    [extracting, setExtracting] = useState(false),
    [extractError, setExtractError] = useState(""),
    [extracted, setExtracted] = useState<ExtractedMetadata | null>(null),
    [role, setRole] = useState<Role | "">("");
  const [doc, setDoc] = useState(""),
    [stage, setStage] = useState(""),
    [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const scheduled = !!d.case.inspection_on;
  const inspection = scheduled && d.role === "reviewer";
  const factoryRecord = scheduled && d.role === "manager";
  const duplicateCap =
    factoryRecord && role === "cap" && !!existingCap && !!file;
  const semanticCheckRan =
    !!extracted &&
    ["valid", "invalid", "uncertain", "unavailable"].includes(
      extracted.content_check,
    );
  const inspectionDateMismatch =
    inspection &&
    !!extracted?.inspection_date &&
    extracted.inspection_date !== d.case.inspection_on;
  const submittedInspectionDateMismatch =
    inspection && !!issuedOn && issuedOn !== d.case.inspection_on;
  const invalidInspectionPdf =
    inspection &&
    !!extracted &&
    (inspectionDateMismatch ||
      submittedInspectionDateMismatch ||
      (semanticCheckRan
        ? extracted.content_check !== "valid"
        : extracted.readable_pages > 0 && extracted.role !== "inspection"));
  const invalidFactoryRecord =
    factoryRecord &&
    !!extracted &&
    extracted.content_check !== "valid" &&
    !(
      extracted.content_check === "not_configured" &&
      extracted.readable_pages > 0 &&
      extracted.role === role
    );
  const exactDuplicate = !!extracted?.duplicate_of;
  const invalidDocument =
    duplicateCap || exactDuplicate || invalidInspectionPdf || invalidFactoryRecord;
  const capDeadlineWarning =
    factoryRecord &&
    role === "cap" &&
    extracted?.cap_submission_deadline &&
    issuedOn > extracted.cap_submission_deadline
      ? `CAP issue date (${issuedOn}) is after the inspection report's submission deadline (${extracted.cap_submission_deadline}). Reviewer review is required.`
      : null;
  const semanticFailureMessage =
    extracted?.content_check === "unavailable"
      ? "The local content check could not complete. Choose a readable PDF and try again."
      : extracted?.content_check === "uncertain"
        ? `The report content could not be confirmed: ${extracted.content_reason || "the text is too ambiguous or incomplete."} Choose a clearer inspection report PDF.`
        : `Invalid document: ${extracted?.content_reason || "the content is not an inspection report."} Choose a relevant inspection report PDF.`;
  const invalidInspectionMessage = inspectionDateMismatch
    ? `Invalid document: the PDF inspection date (${extracted?.inspection_date}) does not match the date scheduled by the admin (${d.case.inspection_on}). Choose the correct report PDF.`
    : submittedInspectionDateMismatch
      ? `The inspection date must match the date scheduled by the admin (${d.case.inspection_on}).`
      : !extracted
        ? ""
        : semanticCheckRan
          ? semanticFailureMessage
          : extracted.role === "other"
            ? "Invalid document: the readable PDF could not be identified as an inspection report. Choose an inspection report PDF."
            : `Invalid document: this PDF was identified as “${roles[extracted.role]}”. Reviewers can upload inspection reports only.`;
  const invalidFactoryRecordMessage =
    extracted?.content_check === "invalid"
      ? `Invalid document: ${extracted.content_reason || "the PDF does not contain the selected factory record type."} Choose the correct record type or a different PDF.`
      : extracted?.content_check === "uncertain"
        ? !role
          ? "The document type is unclear from the full PDF. Choose the record type manually; the complete PDF will then be checked against it."
          : `The selected factory record type could not be confirmed: ${extracted.content_reason || "the PDF text is too ambiguous or incomplete."} Choose a clearer PDF.`
        : extracted?.content_check === "unavailable"
          ? extracted.content_reason || "The local content check could not complete. Choose a readable PDF and try again."
          : extracted?.content_check === "unreadable"
            ? "Invalid document: no readable text was found, so its factory record type cannot be checked. Choose a readable PDF."
            : extracted?.content_check === "not_configured" && extracted.role !== role
            ? `OCR identified this as “${roles[extracted.role]}”, not “${role ? roles[role] : "a selected role"}”. Choose the matching document role or a different PDF.`
              : extracted?.content_reason || "This PDF could not be checked as a factory record.";
  const validationMessage = duplicateCap
    ? "This case already has a CAP. A second CAP cannot be uploaded."
    : exactDuplicate
      ? "This PDF has the same readable document text as an existing upload in this case. Upload blocked as a duplicate."
    : factoryRecord
      ? invalidFactoryRecordMessage
      : invalidInspectionMessage;
  const permitted = Object.entries(roles).filter(
    ([key]) =>
      !scheduled ||
      (d.role === "manager" ? key !== "inspection" : key === "inspection"),
  );
  const month = d.case.inspection_on?.slice(0, 7);
  const [year, monthNumber] = (month || "").split("-").map(Number);
  const monthEnd = month
    ? new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
    : undefined;
  const bounds = inspection ? { min: `${month}-01`, max: monthEnd } : {};
  async function readPdf(selected: File | null, expectedRole: Role | "" = role) {
    setFile(selected);
    setExtractError("");
    setExtracted(null);
    setIssuedOn("");
    setPeriodStart("");
    setPeriodEnd("");
    setDoc("");
    setAttempt(crypto.randomUUID());
    if (!selected) {
      setTitle("");
      return;
    }
    setTitle(selected.name.replace(/\.pdf$/i, "").replaceAll("-", " "));
    setExtracting(true);
    try {
      const body = new FormData();
      body.append("file", selected);
      if (factoryRecord && expectedRole) body.append("role", expectedRole);
      const result = await api<ExtractedMetadata>(
        `/v1/cases/${d.case.id}/inspect-upload`,
        token,
        "POST",
        body,
      );
      const semanticCheckRan = [
        "valid",
        "invalid",
        "uncertain",
        "unavailable",
      ].includes(result.content_check);
      const inferredRole =
        (!factoryRecord || result.content_check === "valid") &&
        permitted.some(([key]) => key === result.role)
        ? result.role
        : null;
      const validInspectionSource =
        !inspection ||
        (semanticCheckRan
          ? result.content_check === "valid"
          : result.readable_pages === 0 || result.role === "inspection");
      const extractedInspectionDateMismatch =
        inspection &&
        !!result.inspection_date &&
        result.inspection_date !== d.case.inspection_on;
      if (
        validInspectionSource &&
        !extractedInspectionDateMismatch &&
        result.title
      )
        setTitle(result.title);
      setIssuedOn(
        validInspectionSource && !extractedInspectionDateMismatch
          ? (inspection && result.inspection_date) || result.issued_on || ""
          : "",
      );
      // If the PDF gives a single inspection date but no reporting-period
      // start, use that dated visit as the start. Never invent a period end.
      const nextPeriodStart =
        validInspectionSource && !extractedInspectionDateMismatch
          ? result.period_start ||
            (inspection ? result.inspection_date || "" : "")
          : "";
      const nextPeriodEnd =
        validInspectionSource && !extractedInspectionDateMismatch
          ? result.period_end || ""
          : "";
      setPeriodStart(nextPeriodStart);
      setPeriodEnd(
        nextPeriodEnd &&
          (!nextPeriodStart || nextPeriodEnd >= nextPeriodStart)
          ? nextPeriodEnd
          : "",
      );
      if (!scheduled && result.issuer) setIssuer(result.issuer);
      const warnings = [...result.warnings];
      if (
        factoryRecord &&
        !!expectedRole &&
        result.content_check === "not_configured" &&
        result.readable_pages > 0 &&
        result.role !== expectedRole
      ) {
        warnings.push(
          `OCR identified this as “${roles[result.role]}”, but the selected role is “${expectedRole ? roles[expectedRole] : "none"}”.`,
        );
      } else if (
        !factoryRecord &&
        !inferredRole &&
        !(inspection && result.role !== "inspection")
      ) {
        warnings.push(
          `OCR identified this as “${roles[result.role]}”, which is not allowed ` +
            "for this case. Check the PDF and enter the permitted document " +
            "details manually.",
        );
      }
      setExtracted({ ...result, warnings });
      if (!expectedRole && inferredRole) setRole(inferredRole);
    } catch (error) {
      setExtractError(message(error));
    } finally {
      setExtracting(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || !role || invalidDocument) return;
    setBusy(true);
    setErr("");
    const form = new FormData(e.currentTarget);
    try {
      setStage("Reserving private upload…");
      const res = await api<components["schemas"]["UploadTicket"]>(
        "/v1/cases/" + d.case.id + "/uploads",
        token,
        "POST",
        {
          request_key: attempt,
          filename: file.name,
          title,
          role,
          document_id: doc || null,
          issued_on: form.get("issued_on") || null,
          period_start: form.get("period_start") || null,
          period_end: form.get("period_end") || null,
          issuer: inspection
            ? "external"
            : d.role === "manager"
              ? "factory"
              : form.get("issuer"),
          confirmed_factory: d.case.factory,
        },
      );
      if (res.upload_url) {
        setStage("Uploading original PDF…");
        const remote = await fetch(res.upload_url, {
          method: "PUT",
          headers: { "Content-Type": "application/pdf", "x-upsert": "false" },
          body: file,
        });
        if (!remote.ok) {
          const info = await remote.json().catch(() => ({}));
          if (
            remote.status !== 409 &&
            !/already exists|duplicate/i.test(info.message || "")
          )
            throw new Error(
              info.message || "The PDF upload failed. Retry this upload.",
            );
        }
      }
      setStage("Queuing text extraction…");
      await api(
        "/v1/document-versions/" + res.version_id + "/finalize",
        token,
        "POST",
      );
      await done();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add a document"
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <label className="upload-box">
          <UploadCloud size={25} />
          <strong>{file?.name || "Choose a PDF"}</strong>
          <small>
            Digital PDF or printed scan · Large reports process in batches
          </small>
          <input
            type="file"
            accept=".pdf,application/pdf"
            disabled={duplicateCap}
            required
            onChange={(e) => {
              setRole("");
              setDoc("");
              void readPdf(e.target.files?.[0] || null, "");
            }}
          />
        </label>
        {extracting && (
          <p className="hint" role="status">
            Reading the full PDF and filling in fields from it…
          </p>
        )}
        {duplicateCap && (
          <p className="callout invalid-document" role="alert">
            This case already has a CAP. A second CAP cannot be uploaded, even
            if it has a different filename. Use the existing CAP record.
          </p>
        )}
        {exactDuplicate && !duplicateCap && (
          <p className="callout invalid-document" role="alert">
            This PDF has the same readable document text as an existing upload
            in this case. It cannot be uploaded again, even with a different
            filename.
          </p>
        )}
        {extracted?.duplicate_warning && !exactDuplicate && (
          <p className="callout duplicate-warning" role="status">
            Possible duplicate: {extracted.duplicate_warning}
          </p>
        )}
        {extractError && (
          <p
            className={`callout${factoryRecord ? " invalid-document" : ""}`}
            role={factoryRecord ? "alert" : "status"}
          >
            {factoryRecord
              ? "The factory document could not be read and verified. Choose a readable PDF and try again."
              : "Automatic reading could not fill the fields. Enter them manually."}
            {` ${extractError}`}
          </p>
        )}
        {extracted && !extractError && (
          <p className="hint" role="status">
            Check the extracted fields before uploading; missing fields can be
            entered manually.
          </p>
        )}
        {(inspection || factoryRecord) && extracted?.content_check === "valid" && (
          <p className="callout success-document" role="status">
            {factoryRecord ? "Factory document check passed" : "Content check passed"}: {extracted.content_reason} This checks the document type, not whether its claims are true.
          </p>
        )}
        {capDeadlineWarning && (
          <p className="deadline-warning" role="alert">
            CAP deadline flag: {capDeadlineWarning}
          </p>
        )}
        {(inspection || factoryRecord) && extracted?.content_check === "not_configured" && (
          <p className="callout" role="status">
            Local OCR content checks are active. They check document type and
            structure, not whether the document's claims are true.
          </p>
        )}
        {(inspection || factoryRecord) && extracted?.content_check === "unreadable" && (
          <p className="callout" role="status">
            The PDF text could not be read, so its document type could not be
            checked. Missing metadata can be entered manually, but choose a
            readable PDF so its contents can be verified.
          </p>
        )}
        {extracted?.warnings
          .filter(
            (warning) =>
              !(
                inspection &&
                warning.includes("does not match the date scheduled")
              ),
          )
          .map((warning) => (
            <p className="callout" role="alert" key={warning}>
              {warning}
            </p>
          ))}
        {invalidDocument && !duplicateCap && !exactDuplicate && (
          <p className="callout invalid-document" role="alert">
            {validationMessage}
          </p>
        )}
        <label>
          Document title
          <input
            required
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Document role
          <select
            required
            value={role}
            onChange={(e) => {
              const nextRole = e.target.value as Role;
              setRole(nextRole);
              setDoc("");
              if (factoryRecord && file) void readPdf(file, nextRole);
            }}
          >
            <option value="">Choose a document role</option>
            {permitted.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          {file && !role && (
            <small>OCR could not identify the role. Select it manually.</small>
          )}
        </label>
        <div className="field-pair">
          {!scheduled && (
            <label>
              Issuer
              <select
                name="issuer"
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
              >
                <option value="unknown">Unknown</option>
                <option value="factory">Factory</option>
                <option value="external">External reviewer</option>
              </select>
            </label>
          )}
        </div>
        {!duplicateCap && (
          <label>
            Document relationship
            <select value={doc} onChange={(e) => setDoc(e.target.value)}>
              <option value="">New, separate record</option>
              {d.documents
                .filter((v) => v.role === role)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    Revision of {v.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          {inspection ? "Inspection date on the PDF" : "Issue date"}
          <input
            name="issued_on"
            type="date"
            required={inspection || factoryRecord}
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
          />
        </label>
        {inspection && (
          <p className="hint">
            Include a readable “Inspection date: YYYY-MM-DD” near the start of
            the PDF. It must match the entered date and fall in {month}.
          </p>
        )}
        {factoryRecord && (
          <p className="hint">
            Dates are filled from the PDF when readable. Factory records may
            describe events before the inspection or corrective work after it,
            so their dates do not have to match the inspection date.
          </p>
        )}
        {!factoryRecord && role !== "cap" && (
          <div className="field-pair">
            <label>
              Period starts
              <input
                name="period_start"
                type="date"
                value={periodStart}
                onChange={(e) => {
                  const next = e.target.value;
                  setPeriodStart(next);
                  if (periodEnd && next && periodEnd < next) setPeriodEnd("");
                }}
                {...bounds}
              />
            </label>
            <label>
              Period ends
              <input
                name="period_end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                {...bounds}
                min={periodStart || bounds.min}
              />
            </label>
          </div>
        )}
        {inspection &&
          extracted?.inspection_date &&
          !extracted.period_start && (
            <p className="hint">
              The PDF has an inspection date but no separate period start. The
              inspection date was filled as the start; the end date stays blank
              unless the PDF states one.
            </p>
          )}
        <label className="checkline">
          <input type="checkbox" required />I confirm I have permission to
          upload this document and it belongs to {d.case.factory}.
        </label>
        {err && <ErrorNote text={err} />}
        <div className="form-actions">
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              extracting ||
              !role ||
              !file ||
              duplicateCap ||
              invalidDocument ||
              (factoryRecord && !!extractError)
            }
          >
            {busy ? stage : "Upload document"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
