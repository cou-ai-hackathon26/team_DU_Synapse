"use client";

import { FormEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  ClipboardList,
  FileText,
  Plus,
  Upload,
  UserPlus,
} from "lucide-react";
import { api, dateText, Dossier, message } from "@/lib/api";
import { Busy, ErrorNote, Modal, Tag } from "./ui";
import { Preview } from "./viewer";

type Task = {
  id: string;
  title: string;
  detail: string;
  assignee: string;
  due_on: string;
  status:
    | "assigned"
    | "in_progress"
    | "submitted"
    | "needs_revision"
    | "reviewed";
};
type Submission = {
  id: string;
  task_id: string;
  filename: string;
  imported_version: string | null;
};
type Event = {
  id: string;
  task_id: string;
  action: string;
  note: string;
  created_at: string;
};
type Board = {
  role: "reviewer" | "manager";
  tasks: Task[];
  evidence: Submission[];
  events: Event[];
};
const labels: Record<Task["status"], string> = {
  assigned: "Assigned",
  in_progress: "In progress",
  submitted: "Awaiting auditor review",
  needs_revision: "Revision requested",
  reviewed: "Evidence accepted",
};
const eventLabels: Record<string, string> = {
  assigned: "Task assigned",
  started: "Work started",
  submitted: "Evidence submitted",
  return: "Auditor requested revision",
  accept: "Auditor accepted evidence",
  imported: "Added to verification",
  comment: "Factory comment",
};

export function CorrectiveWork({
  dossier,
  token,
  preview,
  refresh,
}: {
  dossier: Dossier;
  token: string;
  preview: (item: Preview) => void;
  refresh: () => Promise<void>;
}) {
  const cid = dossier.case.id;
  const [dialog, setDialog] = useState<"task" | "share" | null>(null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const board = useQuery({
    queryKey: ["corrective-work", cid],
    queryFn: () => api<Board>(`/v1/cases/${cid}/corrective-work`, token),
  });
  if (board.isLoading) return <Busy text="Opening corrective work…" />;
  if (board.error || !board.data)
    return <ErrorNote text={message(board.error)} />;
  const { role, tasks, evidence, events } = board.data;
  const writable = !dossier.case.archived && !dossier.case.deleting;
  const reviewer = role === "reviewer";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const overdue = tasks.filter(
    (task) =>
      task.due_on < today && !["reviewed", "submitted"].includes(task.status),
  );

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(
        `/v1/cases/${cid}/${dialog === "share" ? "share-manager" : "corrective-work"}`,
        token,
        "POST",
        data,
      );
      if (dialog === "share")
        setNotice("Case shared with the Factory Manager account.");
      setDialog(null);
      await board.refetch();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="section-head">
          <div>
            <h2>Corrective work</h2>
            <p>
              {reviewer
                ? "Share work with the factory and review submitted evidence."
                : "Track deadlines, comment and submit evidence to the auditor."}
            </p>
          </div>
          {writable && reviewer && (
            <div className="inline-actions">
              {reviewer && (
                <button
                  onClick={() => {
                    setError("");
                    setDialog("share");
                  }}
                >
                  <UserPlus size={16} />
                  Share with manager
                </button>
              )}
              <button
                className="primary"
                onClick={() => {
                  setError("");
                  setDialog("task");
                }}
              >
                <Plus size={16} />
                Assign task
              </button>
            </div>
          )}
        </div>
        {notice && (
          <p className="notice" role="status">
            <Check size={16} />
            {notice}
          </p>
        )}
        <div className="cap-header corrective-summary">
          <div>
            <strong>{tasks.length}</strong>
            <small>Assigned tasks</small>
          </div>
          <div>
            <strong>{overdue.length}</strong>
            <small>Overdue</small>
          </div>
          <div>
            <strong>
              {tasks.filter((task) => task.status === "submitted").length}
            </strong>
            <small>Awaiting auditor</small>
          </div>
          <div>
            <strong>
              {tasks.filter((task) => task.status === "reviewed").length}
            </strong>
            <small>Evidence accepted</small>
          </div>
        </div>
        <div className="filters">
          <label>
            Status
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All tasks</option>
              {Object.entries(labels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {!tasks.some((task) => filter === "all" || task.status === filter) && (
        <section className="panel blank">
          <span className="large-icon">
            <ClipboardList />
          </span>
          <h3>No tasks in this view</h3>
          <p>
            {reviewer
              ? "Assign a corrective task with an owner and a deadline."
              : "Assigned work will appear here."}
          </p>
        </section>
      )}
      {tasks
        .filter((task) => filter === "all" || task.status === filter)
        .map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            evidence={evidence.filter((entry) => entry.task_id === task.id)}
            events={events.filter((entry) => entry.task_id === task.id)}
            overdue={overdue.some((entry) => entry.id === task.id)}
            reviewer={reviewer}
            writable={writable}
            token={token}
            preview={preview}
            updated={async () => {
              await board.refetch();
              await refresh();
            }}
          />
        ))}
      {dialog && (
        <Modal
          title={
            dialog === "share"
              ? "Share with Factory Manager"
              : "Assign corrective task"
          }
          close={() => {
            if (!busy) setDialog(null);
          }}
        >
          <form onSubmit={submitForm}>
            {dialog === "share" ? (
              <label>
                Factory Manager email
                <input
                  type="email"
                  name="email"
                  placeholder="factory-manager@safetyproof.test"
                  required
                />
              </label>
            ) : (
              <>
                <label>
                  Task title
                  <input
                    name="title"
                    required
                    maxLength={160}
                    placeholder="Clear the aisle at Exit E-02"
                  />
                </label>
                <div className="field-pair">
                  <label>
                    Assign to
                    <input
                      name="assignee"
                      required
                      maxLength={120}
                      placeholder="Person or department"
                    />
                  </label>
                  <label>
                    Due date
                    <input name="due_on" type="date" required />
                  </label>
                </div>
                <label>
                  Instructions
                  <textarea
                    name="detail"
                    rows={3}
                    maxLength={3000}
                    placeholder="Describe the corrective action and any evidence to submit"
                  />
                </label>
              </>
            )}
            {error && <ErrorNote text={error} />}
            <div className="form-actions">
              <button
                type="button"
                onClick={() => setDialog(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {dialog === "share" ? "Share case" : "Assign task"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function TaskCard({
  task,
  evidence,
  events,
  overdue,
  reviewer,
  writable,
  token,
  preview,
  updated,
}: {
  task: Task;
  evidence: Submission[];
  events: Event[];
  overdue: boolean;
  reviewer: boolean;
  writable: boolean;
  token: string;
  preview: (item: Preview) => void;
  updated: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const managerCanSubmit =
    !reviewer &&
    writable &&
    !overdue &&
    ["assigned", "in_progress", "needs_revision"].includes(task.status);
  async function change(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      setNote("");
      setFile(null);
      await updated();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    if (!file) return;
    await change(async () => {
      const ticket = await api<{ upload_url: string; receipt: string }>(
        `/v1/corrective-tasks/${task.id}/uploads`,
        token,
        "POST",
        { filename: file.name },
      );
      const res = await fetch(ticket.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      if (!res.ok)
        throw new Error("The evidence upload failed. Please try again.");
      await api(
        `/v1/corrective-tasks/${task.id}/uploads/finalize`,
        token,
        "POST",
        {
          receipt: ticket.receipt,
        },
      );
    });
  }
  const event = (action: string) =>
    change(() =>
      api(`/v1/corrective-tasks/${task.id}/events`, token, "POST", {
        action,
        note,
      }),
    );
  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <h2>{task.title}</h2>
          <p>
            {task.assignee} · Due {dateText(task.due_on)}
          </p>
        </div>
        <div className="inline-actions">
          {overdue && <Tag tone="red">Overdue</Tag>}
          <Tag
            tone={
              task.status === "reviewed"
                ? "green"
                : task.status === "needs_revision"
                  ? "amber"
                  : ""
            }
          >
            {labels[task.status]}
          </Tag>
        </div>
      </div>
      {task.detail && (
        <p className="panel-pad task-detail" dir="auto">
          {task.detail}
        </p>
      )}
      {overdue && !reviewer && (
        <p className="notice" role="status">
          The deadline has passed. Factory evidence can no longer be submitted.
        </p>
      )}
      {evidence.map((entry) => (
        <div className="file-row" key={entry.id}>
          <span className="doc-icon other">
            <FileText size={18} />
          </span>
          <span className="row-main">
            <b>{entry.filename}</b>
            <small>
              From factory{entry.imported_version ? " · Added to case documents" : ""}
            </small>
          </span>
          <button
            onClick={() =>
              preview({ title: entry.filename, correctiveEvidence: entry.id })
            }
          >
            Open PDF
          </button>
          {reviewer && writable && !entry.imported_version && (
            <button
              disabled={busy}
              onClick={() =>
                void change(() =>
                  api(
                    `/v1/corrective-evidence/${entry.id}/import`,
                    token,
                    "POST",
                  ),
                )
              }
            >
              Add to verification
            </button>
          )}
        </div>
      ))}
      {events.length > 0 && (
        <details className="coverage" open={task.status === "needs_revision"}>
          <summary>Task activity</summary>
          <ul>
            {events.map((entry) => (
              <li key={entry.id}>
                {eventLabels[entry.action]} · {dateText(entry.created_at)}
                {entry.note ? ` · ${entry.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!reviewer && writable && (
        <div className="panel-pad">
          <label>
            Factory comment
            <textarea
              value={note}
              rows={2}
              maxLength={3000}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !note.trim()}
            onClick={() => void event("comment")}
          >
            Add comment
          </button>
        </div>
      )}
      {(managerCanSubmit ||
        (reviewer && writable && task.status === "submitted")) && (
        <div className="panel-pad">
          {managerCanSubmit ? (
            <div className="inline-actions">
              {task.status !== "in_progress" && (
                <button disabled={busy} onClick={() => void event("started")}>
                  <CalendarDays size={16} />
                  Start work
                </button>
              )}
              <label>
                Evidence PDF
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
              <button
                className="primary"
                disabled={!file || busy}
                onClick={() => void upload()}
              >
                <Upload size={15} />
                Submit evidence
              </button>
            </div>
          ) : (
            <>
              <label>
                Auditor note
                <textarea
                  rows={2}
                  maxLength={3000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Explain any revision required"
                />
              </label>
              <div className="inline-actions">
                <button
                  disabled={busy || !note.trim()}
                  onClick={() => void event("return")}
                >
                  Request revision
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void event("accept")}
                >
                  <Check size={16} />
                  Accept evidence
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {error && <ErrorNote text={error} />}
    </section>
  );
}
