"use client";

import { FormEvent, useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiBase, dateText, message, outcomes } from "@/lib/api";
import type { Outcome } from "@/lib/api";
import type { Factory } from "./onboarding";
import { Busy, ErrorNote, Modal, Tag } from "./ui";
import { ReviewerFields, reviewerDetails } from "./reviewer-fields";

function isoDay(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDay(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function nextIsoDay(value: string) {
  const date = parseIsoDay(value);
  date.setDate(date.getDate() + 1);
  return isoDay(date);
}

function FollowUpCalendar({
  value,
  minDate,
  blockedDates,
  disabled,
  onChange,
}: {
  value: string;
  minDate: string;
  blockedDates: Set<string>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const minimum = parseIsoDay(minDate);
  const [month, setMonth] = useState(
    () => new Date(minimum.getFullYear(), minimum.getMonth(), 1),
  );
  const [calendarVisible, setCalendarVisible] = useState(true);
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const firstWeekday = monthStart.getDay();
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  const previousMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
  const canGoBack =
    previousMonth.getFullYear() > minimum.getFullYear() ||
    (previousMonth.getFullYear() === minimum.getFullYear() &&
      previousMonth.getMonth() >= minimum.getMonth());

  return (
    <div className="follow-up-date-picker">
      <label>
        Follow-up inspection date
        <div className="follow-up-date-value">
          <input
            type="text"
            readOnly
            value={value ? dateText(value) : ""}
            placeholder="Choose a date from the calendar"
            aria-label="Selected follow-up inspection date"
            disabled={disabled}
          />
          <button
            type="button"
            aria-expanded={calendarVisible}
            aria-label={`${calendarVisible ? "Hide" : "Show"} calendar`}
            disabled={disabled}
            onClick={() => setCalendarVisible((visible) => !visible)}
          >
            <CalendarDays size={18} aria-hidden />
          </button>
        </div>
      </label>
      {calendarVisible && (
        <div className="follow-up-calendar" aria-label="Choose inspection date">
          <div className="follow-up-calendar-head">
            <button
              type="button"
              aria-label="Previous month"
              disabled={disabled || !canGoBack}
              onClick={() => setMonth(previousMonth)}
            >
              ‹
            </button>
            <strong>
              {month.toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              })}
            </strong>
            <button
              type="button"
              aria-label="Next month"
              disabled={disabled}
              onClick={() =>
                setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
              }
            >
              ›
            </button>
          </div>
          <div className="follow-up-calendar-grid" role="grid">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
              <span className="follow-up-calendar-weekday" key={day}>
                {day}
              </span>
            ))}
            {Array.from({ length: firstWeekday }, (_, index) => (
              <span className="follow-up-calendar-empty" key={`empty-${index}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = index + 1;
              const date = new Date(month.getFullYear(), month.getMonth(), day);
              const iso = isoDay(date);
              const beforeMinimum = iso < minDate;
              const alreadyAssigned = blockedDates.has(iso);
              const selected = value === iso;
              return (
                <button
                  className={selected ? "selected" : undefined}
                  type="button"
                  role="gridcell"
                  key={iso}
                  disabled={disabled || beforeMinimum || alreadyAssigned}
                  aria-pressed={selected}
                  aria-label={`${date.toLocaleDateString(undefined, {
                    dateStyle: "full",
                  })}${alreadyAssigned ? ", reviewer already assigned" : ""}`}
                  title={
                    beforeMinimum
                      ? "A follow-up must be after the earlier inspection."
                      : alreadyAssigned
                        ? "This reviewer already has an inspection on this date."
                        : undefined
                  }
                  onClick={() => onChange(iso)}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <p className="follow-up-calendar-note">
            Dates before the previous inspection and dates already assigned to
            this reviewer are unavailable.
          </p>
        </div>
      )}
    </div>
  );
}

type Reviewer = {
  id: string;
  full_name: string;
  email: string;
  status: string;
  created_at: string;
  role_type: string | null;
  organization: string | null;
  reviewer_factories: { factory_id: string }[];
};
type Application = {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  job_title: string;
  status: string;
  created_at: string;
  requested_factory_id: string | null;
  factory_id: string | null;
  reject_reason: string | null;
  has_id_card: boolean;
  card_cleanup_pending: boolean;
  id_card_number: string | null;
  membership_number: string | null;
  consent_at: string | null;
  id_card_deleted_at: string | null;
  requested_factory: Factory | null;
  active_manager_factory_ids: string[];
  id_card_review?: {
    card_status: "missing" | "unreadable" | "readable";
    name_status: "match" | "not_found" | "not_checked";
    number_status:
      | "match"
      | "mismatch"
      | "not_found"
      | "not_entered"
      | "not_checked";
    extracted_number: string | null;
  } | null;
};
type FactorySummary = Factory & {
  managers: number;
  reviewers: number;
  cases: {
    id: string;
    title: string;
    findings: Record<Outcome, number>;
    open_tasks: number;
    archived: boolean;
  }[];
};
type CaseSummary = {
  case: {
    title: string;
    factory: string;
    reviewer_id: string | null;
    inspection_on: string | null;
  };
  run: { created_at: string } | null;
  results: {
    id: string;
    claim: { source: { quote: string } };
    outcome: Outcome;
    reason: string;
  }[];
  tasks: { id: string; title: string; due_on: string; status: string }[];
  documents: { id: string; title: string }[];
};
type ScheduledInspection = {
  id: string;
  title: string;
  factory: string;
  reviewer_id: string | null;
  inspection_kind?: "initial" | "follow_up";
  follow_up_of?: string | null;
  follow_up_root_id?: string | null;
  follow_up_number?: number;
  programme: string | null;
  inspection_on: string;
  reviewer_name: string | null;
  reviewer_organization: string | null;
  manager_notified_at: string | null;
  report_status: "scheduled" | "in_progress" | "complete" | "needs_attention";
};
type View =
  | "factories"
  | "reviewers"
  | "factory-assignments"
  | "scheduled-inspections"
  | "manager-applications";
function status(value: string) {
  return value.replaceAll("_", " ");
}

export function AdminWorkspace({
  token,
  view,
}: {
  token: string;
  view: View;
}) {
  const cache = useQueryClient();
  const [add, setAdd] = useState(false);
  const [addingFactory, setAddingFactory] = useState(false);
  const [factoryName, setFactoryName] = useState("");
  const [factoryAddress, setFactoryAddress] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [assignmentFactoryId, setAssignmentFactoryId] = useState("");
  const [inspectionKind, setInspectionKind] = useState<
    "initial" | "follow_up"
  >("initial");
  const [followUpOf, setFollowUpOf] = useState("");
  const [caseFormKey, setCaseFormKey] = useState(0);
  const [caseCreated, setCaseCreated] = useState(false);
  const [followUpTarget, setFollowUpTarget] =
    useState<ScheduledInspection | null>(null);
  const [followUpDate, setFollowUpDate] = useState("");
  const [followUpRequestSent, setFollowUpRequestSent] = useState("");
  const [notificationMessage, setNotificationMessage] = useState("");
  const [selected, setSelected] = useState("");
  const [caseId, setCaseId] = useState("");
  const details = useQuery({
    queryKey: ["admin-case", caseId, token],
    queryFn: () => api<CaseSummary>(`/v1/admin/cases/${caseId}`, token),
    enabled: !!caseId,
  });
  const [invite, setInvite] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deactivate, setDeactivate] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteAccount, setDeleteAccount] = useState<{
    id: string;
    name: string;
    role: "reviewer" | "factory_manager";
  } | null>(null);
  const factories = useQuery({
    queryKey: ["admin-factories", token],
    queryFn: () => api<FactorySummary[]>("/v1/admin/factories", token),
  });
  const reviewers = useQuery({
    queryKey: ["admin-reviewers", token],
    queryFn: () => api<Reviewer[]>("/v1/admin/reviewers", token),
    enabled: view !== "manager-applications",
  });
  const scheduledInspections = useQuery({
    queryKey: ["admin-scheduled-inspections", token],
    queryFn: () =>
      api<ScheduledInspection[]>("/v1/admin/scheduled-inspections", token),
    enabled: view === "scheduled-inspections" || view === "factory-assignments",
  });
  const followUpSupport = useQuery({
    queryKey: ["admin-follow-up-support", token],
    queryFn: () =>
      api<{ enabled: boolean }>("/v1/admin/follow-up-support", token),
    enabled: view === "factory-assignments" || view === "scheduled-inspections",
    retry: false,
  });
  const managers = useQuery({
    queryKey: ["admin-applications", token],
    queryFn: () => api<Application[]>("/v1/admin/manager-applications", token),
    enabled: view === "manager-applications",
    refetchInterval: 15_000,
  });
  const unseenManagerApplications = useQuery({
    queryKey: ["admin-unseen-manager-applications", token],
    queryFn: () =>
      api<{ count: number }>(
        "/v1/admin/manager-applications/unseen-count",
        token,
      ),
    enabled: view !== "manager-applications",
    refetchInterval: 15_000,
  });
  useEffect(() => {
    setError("");
    setSelected("");
    setCaseId("");
  }, [view]);
  useEffect(() => {
    if (
      view !== "manager-applications" ||
      managers.isLoading ||
      managers.error ||
      !managers.data
    )
      return;
    let active = true;
    void api(
      "/v1/admin/manager-applications/mark-seen",
      token,
      "POST",
    )
      .then(() => {
        if (active) {
          void cache.invalidateQueries({
            queryKey: ["admin-unseen-manager-applications", token],
          });
        }
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    return () => {
      active = false;
    };
  }, [
    view,
    token,
    managers.data,
    managers.dataUpdatedAt,
    managers.isLoading,
    managers.error,
    cache,
  ]);
  const assignees =
    reviewers.data?.filter((row) => row.status === "active") || [];
  const assignee = assignees.find((row) => row.id === assigneeId);
  const assignmentFactory = factories.data?.find(
    (row) => row.id === assignmentFactoryId,
  );
  const eligibleFollowUps = (scheduledInspections.data || []).filter(
    (item) =>
      item.factory === assignmentFactory?.name &&
      item.report_status === "complete" &&
      !(scheduledInspections.data || []).some(
        (later) => later.follow_up_of === item.id,
      ),
  );
  const selectedPreviousInspection = eligibleFollowUps.find(
    (item) => item.id === followUpOf,
  );
  const followUpEnabled = followUpSupport.data?.enabled === true;
  const followUpNumber = selectedPreviousInspection
    ? Math.max(
        0,
        ...(scheduledInspections.data || [])
          .filter(
            (item) =>
              item.follow_up_root_id ===
              selectedPreviousInspection.follow_up_root_id,
          )
          .map((item) => item.follow_up_number ?? 0),
      ) + 1
    : 1;
  const generatedFollowUpTitle =
    followUpNumber === 1
      ? "Follow-up Inspection"
      : `Follow-up Inspection ${followUpNumber}`;
  const names = new Map(factories.data?.map((f) => [f.id, f.name]));

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function addReviewer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      const response = await api<{ invite_url: string }>(
        "/v1/admin/reviewers",
        token,
        "POST",
        reviewerDetails(form),
      );
      setAdd(false);
      setCopied(false);
      setInvite(response.invite_url);
      await reviewers.refetch();
    });
  }

  async function decideRequest(id: string, choice: "approve" | "reject") {
    await perform(async () => {
      const next = await api<{ invite_url?: string }>(
        `/v1/admin/reviewer-requests/${id}/${choice}`,
        token,
        "POST",
      );
      if (next.invite_url) {
        setCopied(false);
        setInvite(next.invite_url);
      }
      await reviewers.refetch();
    });
  }

  async function saveFactory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = factoryName.trim();
    const address = factoryAddress.trim();
    if (!name || !address) {
      setError("Enter the factory name and address.");
      return;
    }
    await perform(async () => {
      await api("/v1/admin/factories", token, "POST", {
        name,
        address,
      });
      setFactoryName("");
      setFactoryAddress("");
      setAddingFactory(false);
      await factories.refetch();
    });
  }

  async function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assignmentFactory || !assignee || caseCreated) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    await perform(async () => {
      const created = await api<{
        id: string;
        title: string;
        manager_notified_at: string | null;
      }>(
        "/v1/admin/cases",
        token,
        "POST",
        {
          ...fields,
          factory: assignmentFactory.name,
          reviewer_id: assignee.id,
          programme: fields.programme || null,
        },
      );
      setCaseCreated(true);
      setNotificationMessage(
        `${created.title} assigned${
          inspectionKind === "follow_up"
            ? `; ${assignee.full_name} can access the earlier inspection files`
            : ""
        }. ${
          created.manager_notified_at
            ? "The factory manager has been notified."
            : "No active factory manager was available to notify."
        }`,
      );
      await factories.refetch();
      await scheduledInspections.refetch();
    });
  }

  async function requestFollowUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const previous = followUpTarget;
    if (!previous?.reviewer_id || !followUpDate) return;
    const earliestDate = nextIsoDay(previous.inspection_on);
    if (followUpDate < earliestDate) {
      setError("Choose a date after the previous inspection.");
      return;
    }
    const dateAlreadyAssigned = (scheduledInspections.data || []).some(
      (item) =>
        item.id !== previous.id &&
        item.reviewer_id === previous.reviewer_id &&
        item.inspection_on === followUpDate,
    );
    if (dateAlreadyAssigned) {
      setError("This inspector already has an inspection on that date.");
      return;
    }
    const previousReviewer = reviewers.data?.find(
      (row) => row.id === previous.reviewer_id && row.status === "active",
    );
    if (!previousReviewer) {
      setError(
        "The previous inspector is no longer active. Assign this follow-up from Factory assignments.",
      );
      return;
    }
    await perform(async () => {
      const created = await api<{ title: string }>(
        "/v1/admin/cases",
        token,
        "POST",
        {
          title: "Follow-up Inspection",
          factory: previous.factory,
          programme: previous.programme,
          reviewer_id: previousReviewer.id,
          inspection_on: followUpDate,
          inspection_kind: "follow_up",
          follow_up_of: previous.id,
        },
      );
      setFollowUpRequestSent(
        `${created.title} assigned to ${previousReviewer.full_name}. The inspector can access the earlier inspection files.`,
      );
      setFollowUpTarget(null);
      setFollowUpDate("");
      await scheduledInspections.refetch();
    });
  }

  function startNewCase() {
    setCaseFormKey((key) => key + 1);
    setCaseCreated(false);
    setAssignmentFactoryId("");
    setAssigneeId("");
    setInspectionKind("initial");
    setFollowUpOf("");
    setNotificationMessage("");
    setError("");
  }

  return (
    <>
      <div className="admin-content unified-admin-content">
        {view !== "manager-applications" &&
          (unseenManagerApplications.data?.count || 0) > 0 && (
            <p className="v2-workspace-notice" role="status">
              New manager applications are waiting for review.
            </p>
          )}
        {error && !add && !deactivate && !addingFactory && (
          <ErrorNote text={error} />
        )}
        {view === "factories" && (
          <section className="panel">
            <div className="section-head">
              <h1>Factory safety overview</h1>
              <div className="inline-actions">
                <button
                  onClick={() => {
                    setError("");
                    setAddingFactory((open) => !open);
                  }}
                >
                  {addingFactory ? "Cancel" : "Add factory"}
                </button>
              </div>
            </div>
            {addingFactory && (
              <form className="panel-pad admin-form" onSubmit={saveFactory}>
                <h2>Add factory</h2>
                <label>
                  Factory name
                  <input
                    required
                    maxLength={200}
                    value={factoryName}
                    onChange={(event) => setFactoryName(event.target.value)}
                  />
                </label>
                <label>
                  Factory address
                  <textarea
                    required
                    maxLength={500}
                    rows={3}
                    value={factoryAddress}
                    onChange={(event) => setFactoryAddress(event.target.value)}
                  />
                </label>
                {error && <ErrorNote text={error} />}
                <button className="primary" disabled={busy}>
                  Save factory
                </button>
              </form>
            )}
            {factories.isLoading && <Busy />}
            {factories.error && <ErrorNote text={message(factories.error)} />}
            {factories.data?.map((factory) => (
              <div className="admin-row" key={factory.id}>
                <div>
                  <strong>{factory.name}</strong>
                  <small>{factory.address}</small>
                  <small>
                    {factory.managers} active managers · {factory.reviewers}{" "}
                    active reviewers
                  </small>
                </div>
                {factory.cases.length ? (
                  <ul>
                    {factory.cases.map((item) => (
                      <li key={item.id}>
                        <button onClick={() => setCaseId(item.id)}>
                          {item.title}
                          {item.archived ? " · Archived" : ""}
                        </button>
                        <small>{item.open_tasks} open corrective tasks</small>
                        <small>
                          {Object.entries(item.findings)
                            .map(
                              ([key, count]) =>
                                `${count} ${outcomes[key as Outcome] || key}`,
                            )
                            .join(" · ") || "No published assessments"}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">No review cases yet</p>
                )}
              </div>
            ))}
          </section>
        )}
        {view === "reviewers" && (
          <section className="panel">
            <div className="section-head">
              <h1>Reviewers</h1>
              <button
                className="primary"
                onClick={() => {
                  setError("");
                  setAdd(true);
                }}
              >
                Add reviewer
              </button>
            </div>
            {reviewers.isLoading && <Busy />}
            {reviewers.error && <ErrorNote text={message(reviewers.error)} />}
            {reviewers.data?.map((row) => (
              <div className="admin-row" key={row.id}>
                <div className="reviewer-profile">
                  <strong>{row.full_name}</strong>
                  <dl className="reviewer-fields">
                    <dt>Email</dt>
                    <dd>{row.email}</dd>
                    <dt>Role type</dt>
                    <dd>{row.role_type || "Unspecified"}</dd>
                    <dt>Organization</dt>
                    <dd>{row.organization || "Unspecified"}</dd>
                    <dt>Created</dt>
                    <dd>{dateText(row.created_at)}</dd>
                    <dt>Factories</dt>
                    <dd>
                      {row.reviewer_factories
                        .map((f) => names.get(f.factory_id))
                        .filter(Boolean)
                        .join(", ") || "No factory assignments"}
                    </dd>
                  </dl>
                </div>
                <div className="inline-actions">
                  <Tag
                    tone={
                      row.status === "active"
                        ? "green"
                        : row.status === "deleted"
                          ? "red"
                          : "amber"
                    }
                  >
                    {row.status === "pending_approval"
                      ? "Access requested"
                      : status(row.status)}
                  </Tag>
                  {row.status === "pending_approval" && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => void decideRequest(row.id, "approve")}
                      >
                        Approve and create invite
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void decideRequest(row.id, "reject")}
                      >
                        Reject request
                      </button>
                    </>
                  )}
                  {row.status === "pending" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const next = await api<{ invite_url: string }>(
                            `/v1/admin/reviewers/${row.id}/resend-invite`,
                            token,
                            "POST",
                          );
                          setCopied(false);
                          setInvite(next.invite_url);
                        })
                      }
                    >
                      Resend invite
                    </button>
                  )}
                  {["pending", "active"].includes(row.status) && (
                    <button
                      onClick={() => {
                        setError("");
                        setDeactivate({ id: row.id, name: row.full_name });
                      }}
                    >
                      Deactivate
                    </button>
                  )}
                  {row.status === "deactivated" && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await api(
                              `/v1/admin/accounts/${row.id}/reactivate`,
                              token,
                              "POST",
                              {},
                            );
                            await Promise.all([
                              reviewers.refetch(),
                              factories.refetch(),
                            ]);
                          })
                        }
                      >
                        Reactivate
                      </button>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          setDeleteAccount({
                            id: row.id,
                            name: row.full_name,
                            role: "reviewer",
                          })
                        }
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}
        {view === "factory-assignments" && (
          <section className="panel">
            <div className="section-head">
              <div>
                <h1>Factory assignments</h1>
                <p>
                  Schedule inspections with an active reviewer. Assigning a case
                  gives that reviewer access to its factory.
                </p>
              </div>
            </div>
            <form
              key={caseFormKey}
              className="panel-pad admin-form"
              onSubmit={createCase}
            >
              {reviewers.isLoading && <Busy />}
              {reviewers.error && <ErrorNote text={message(reviewers.error)} />}
              {factories.error && <ErrorNote text={message(factories.error)} />}
              {scheduledInspections.error && (
                <ErrorNote text={message(scheduledInspections.error)} />
              )}
              <label>
                Factory
                <select
                  value={assignmentFactoryId}
                  disabled={busy || !factories.data?.length}
                  onChange={(event) => {
                    setAssignmentFactoryId(event.target.value);
                    setAssigneeId("");
                    setFollowUpOf("");
                    setError("");
                  }}
                >
                  <option value="">Choose a factory</option>
                  {factories.data?.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              {!factories.isLoading &&
                !factories.error &&
                !factories.data?.length && (
                  <p>
                    No factories available. Add a factory in the Factories page
                    first.
                  </p>
                )}
              <label>
                Reviewer
                <select
                  value={assigneeId}
                  disabled={busy || !assignees.length}
                  onChange={(event) => {
                    setAssigneeId(event.target.value);
                    setError("");
                  }}
                >
                  <option value="">Choose an active reviewer</option>
                  {assignees.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.full_name} · {row.email}
                    </option>
                  ))}
                </select>
              </label>
              {!reviewers.isLoading &&
                !reviewers.error &&
                !assignees.length && <p>No active reviewers available.</p>}
              <label>
                Inspection type
                <select
                  value={inspectionKind}
                  disabled={busy || caseCreated}
                  onChange={(event) => {
                    setInspectionKind(
                      event.target.value as "initial" | "follow_up",
                    );
                    setFollowUpOf("");
                    setError("");
                  }}
                >
                  <option value="initial">Initial inspection</option>
                  <option
                    value="follow_up"
                    disabled={!followUpEnabled || !eligibleFollowUps.length}
                  >
                    Follow-up inspection
                  </option>
                </select>
              </label>
              {!followUpEnabled && (
                <p className="hint">
                  Follow-up scheduling will be available after the database
                  migration and API restart. Initial inspections remain available.
                </p>
              )}
              {followUpEnabled &&
                assignmentFactory &&
                !eligibleFollowUps.length && (
                  <p className="hint">
                    Follow-up is available after this factory has a published
                    initial inspection.
                  </p>
                )}
              {inspectionKind === "follow_up" && followUpEnabled && (
                <>
                  <input
                    type="hidden"
                    name="inspection_kind"
                    value="follow_up"
                  />
                  <label>
                    Continue an earlier inspection
                    <select
                      name="follow_up_of"
                      required
                      value={followUpOf}
                      disabled={busy || caseCreated || !assignmentFactory}
                      onChange={(event) => setFollowUpOf(event.target.value)}
                    >
                      <option value="">Choose a published inspection</option>
                      {eligibleFollowUps.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title} · {dateText(item.inspection_on)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!eligibleFollowUps.length && assignmentFactory && (
                    <p className="hint">
                      No published earlier inspection is available for this factory.
                    </p>
                  )}
                  {selectedPreviousInspection && (
                    <p className="hint">
                      The new reviewer will get access to the files from this
                      inspection and all earlier inspections in its series. This
                      visit will be called {generatedFollowUpTitle}.
                    </p>
                  )}
                </>
              )}
              {assignmentFactory && assignee && (
                <p>
                  Assigning this inspection will give {assignee.full_name} access
                  to {assignmentFactory.name}.
                </p>
              )}
              <h2>Schedule inspection</h2>
              {inspectionKind === "initial" ? (
                <label>
                  Case title
                  <input
                    name="title"
                    maxLength={160}
                    required
                    placeholder="e.g. April safety review"
                  />
                </label>
              ) : (
                <input type="hidden" name="title" value={generatedFollowUpTitle} />
              )}
              <label>
                Inspection programme <small>Optional</small>
                <input name="programme" maxLength={120} />
              </label>
              <label>
                Inspection date
                <input name="inspection_on" type="date" required />
              </label>
              <p className="hint">
                Assigning the inspection creates the case and grants reviewer
                access to the factory. An active factory manager receives a
                dashboard notice automatically when the case is assigned.
              </p>
              {(!assignmentFactory || !assignee) && (
                <p className="hint">
                  Choose a factory and an active reviewer to continue.
                </p>
              )}
              <div className="form-actions">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    caseCreated ||
                    !assignmentFactory ||
                    !assignee ||
                    (inspectionKind === "follow_up" &&
                      (!followUpEnabled || !followUpOf))
                  }
                >
                  {busy ? "Assigning…" : "Assign case"}
                </button>
                {caseCreated && (
                  <button type="button" disabled={busy} onClick={startNewCase}>
                    Assign new case
                  </button>
                )}
              </div>
              {notificationMessage && (
                <p role="status">{notificationMessage}</p>
              )}
            </form>
          </section>
        )}
        {view === "scheduled-inspections" && (
          <section className="panel">
            <div className="section-head">
              <div>
                <h1>Scheduled inspections</h1>
                <p>Track assigned factory inspections and submitted reports.</p>
              </div>
            </div>
            {scheduledInspections.isLoading && <Busy />}
            {scheduledInspections.error && (
              <ErrorNote text={message(scheduledInspections.error)} />
            )}
            {followUpRequestSent && (
              <p className="panel-pad" role="status">
                {followUpRequestSent}
              </p>
            )}
            {scheduledInspections.data?.length === 0 && (
              <p className="panel-pad">No inspections scheduled yet.</p>
            )}
            {scheduledInspections.data?.map((item) => (
              <div className="admin-row" key={item.id}>
                <div>
                  <strong>
                    {item.inspection_kind === "follow_up"
                      ? item.title
                      : `Initial Inspection · ${item.title}`}
                  </strong>
                  <small>
                    {item.factory} · {dateText(item.inspection_on)}
                  </small>
                  <small>
                    Reviewer: {item.reviewer_name || "Unassigned"}
                    {item.reviewer_organization
                      ? ` · ${item.reviewer_organization}`
                      : ""}
                  </small>
                  {item.programme && <small>Programme: {item.programme}</small>}
                </div>
                <div className="inline-actions">
                  <Tag
                    tone={
                      item.report_status === "complete"
                        ? "green"
                        : item.report_status === "needs_attention"
                          ? "red"
                          : "amber"
                    }
                  >
                    {item.report_status === "complete"
                      ? "Complete"
                      : item.report_status === "in_progress"
                        ? "In progress"
                        : item.report_status === "needs_attention"
                          ? "Report needs attention"
                          : "Scheduled"}
                  </Tag>
                  <Tag tone={item.manager_notified_at ? "green" : "amber"}>
                    {item.manager_notified_at
                      ? "Manager notified"
                      : "No manager notified"}
                  </Tag>
                  {followUpSupport.data?.enabled &&
                    item.report_status === "complete" &&
                    item.reviewer_id &&
                    reviewers.data?.some(
                      (row) =>
                        row.id === item.reviewer_id && row.status === "active",
                    ) &&
                    !(scheduledInspections.data || []).some(
                      (later) => later.follow_up_of === item.id,
                    ) && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          setError("");
                          setFollowUpDate("");
                          setFollowUpTarget(item);
                        }}
                      >
                        Request follow-up
                      </button>
                    )}
                  <button onClick={() => setCaseId(item.id)}>View case</button>
                </div>
              </div>
            ))}
          </section>
        )}
        {view === "manager-applications" && (
          <>
            <section className="panel">
              <div className="section-head">
                <h1>Manager applications</h1>
              </div>
              {managers.isLoading && <Busy />}
              {managers.error && <ErrorNote text={message(managers.error)} />}
              {managers.data?.length === 0 && (
                <p className="panel-pad">No applications yet.</p>
              )}
              {managers.data?.map((row) => (
                <div className="admin-row" key={row.id}>
                  <div>
                    <strong>{row.full_name}</strong>
                    <small>
                      {row.email}
                      {row.phone && ` · ${row.phone}`}
                    </small>
                    <small>
                      {names.get(
                        row.requested_factory_id || row.factory_id || "",
                      ) || "Factory unavailable"}{" "}
                      · {dateText(row.created_at)}
                    </small>
                  </div>
                  <Tag
                    tone={
                      row.status === "active"
                        ? "green"
                        : row.status === "deleted"
                          ? "red"
                          : "amber"
                    }
                  >
                    {status(row.status)}
                  </Tag>
                  <button onClick={() => setSelected(row.id)}>
                    View application
                  </button>
                </div>
              ))}
            </section>
            {selected && (
              <ManagerDetail
                key={selected}
                id={selected}
                token={token}
                factories={factories.data || []}
                close={() => setSelected("")}
                requestDelete={(name) =>
                  setDeleteAccount({ id: selected, name, role: "factory_manager" })
                }
                changed={async () => {
                  await Promise.all([
                    managers.refetch(),
                    factories.refetch(),
                    cache.invalidateQueries({
                      queryKey: ["admin-application"],
                    }),
                  ]);
                }}
              />
            )}
          </>
        )}
      </div>
      {caseId && (
        <Modal title="Case conditions" close={() => setCaseId("")}>
          {details.isLoading && <Busy />}
          {details.error && <ErrorNote text={message(details.error)} />}
          {details.data && (
            <div className="admin-form">
              <h2>
                {details.data.case.title} · {details.data.case.factory}
              </h2>
              {details.data.case.inspection_on && (
                <p>
                  Inspection date · {dateText(details.data.case.inspection_on)}
                </p>
              )}
              <p>
                Assigned reviewer:{" "}
                {reviewers.data?.find(
                  (row) => row.id === details.data.case.reviewer_id,
                )?.full_name ||
                  (reviewers.isPending ? "Loading…" : "Unassigned")}
              </p>
              <p>
                {details.data.run
                  ? `Latest published run · ${dateText(details.data.run.created_at)}`
                  : "No published verification run."}
              </p>
              {details.data.results.map((row) => (
                <article key={row.id}>
                  <Tag>{outcomes[row.outcome]}</Tag>
                  <p>{row.claim.source.quote}</p>
                  <p className="hint">{row.reason}</p>
                </article>
              ))}
              <h3>Corrective tasks</h3>
              {details.data.tasks.length ? (
                <ul>
                  {details.data.tasks.map((task) => (
                    <li key={task.id}>
                      {task.title} · {status(task.status)} · Due{" "}
                      {dateText(task.due_on)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No corrective tasks.</p>
              )}
              <h3>Case documents</h3>
              {details.data.documents.length ? (
                <ul>
                  {details.data.documents.map((doc) => (
                    <li key={doc.id}>{doc.title}</li>
                  ))}
                </ul>
              ) : (
                <p>No case documents.</p>
              )}
            </div>
          )}
        </Modal>
      )}
      {followUpTarget && (
        <Modal
          title="Request follow-up inspection"
          close={() => {
            if (!busy) {
              setFollowUpTarget(null);
              setFollowUpDate("");
            }
          }}
        >
          <form className="admin-form" onSubmit={requestFollowUp}>
            <p>
              This creates the follow-up inspection and assigns it directly to
              the previous inspector, {reviewers.data?.find(
                (row) => row.id === followUpTarget.reviewer_id,
              )?.full_name || ""}. They will have access to all earlier
              inspection files in this series.
            </p>
            <p>
              Factory: {followUpTarget.factory} · Previous inspection:{" "}
              {followUpTarget.title}
            </p>
            <FollowUpCalendar
              value={followUpDate}
              minDate={nextIsoDay(followUpTarget.inspection_on)}
              blockedDates={new Set(
                (scheduledInspections.data || [])
                  .filter(
                    (item) =>
                      item.id !== followUpTarget.id &&
                      item.reviewer_id === followUpTarget.reviewer_id,
                  )
                  .map((item) => item.inspection_on),
              )}
              disabled={busy}
              onChange={(value) => {
                setError("");
                setFollowUpDate(value);
              }}
            />
            {error && <ErrorNote text={error} />}
            <div className="form-actions">
              <button className="primary" disabled={busy || !followUpDate}>
                {busy ? "Sending request…" : "Send to previous inspector"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFollowUpTarget(null);
                  setFollowUpDate("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}
      {add && (
        <Modal title="Add reviewer" close={() => setAdd(false)}>
          <form className="admin-form" method="post" onSubmit={addReviewer}>
            <ReviewerFields />
            {error && <ErrorNote text={error} />}
            <button className="primary" disabled={busy}>
              Create reviewer
            </button>
          </form>
        </Modal>
      )}
      {invite && (
        <Modal title="One-time reviewer invite" close={() => setInvite("")}>
          <p>
            Copy and share this link with the reviewer. It expires in 48 hours
            and is shown only here.
          </p>
          <label>
            Invite link
            <input
              readOnly
              value={invite}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button
            className="primary"
            onClick={() =>
              void navigator.clipboard
                .writeText(invite)
                .then(() => setCopied(true))
                .catch(() => setError("Select and copy the link manually."))
            }
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          {error && <ErrorNote text={error} />}
        </Modal>
      )}
      {deactivate && (
        <Modal title="Deactivate reviewer" close={() => setDeactivate(null)}>
          <p>{deactivate.name} will lose workspace access.</p>
          {error && <ErrorNote text={error} />}
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await api(
                  `/v1/admin/accounts/${deactivate.id}/deactivate`,
                  token,
                  "POST",
                  {},
                );
                setDeactivate(null);
                await Promise.all([reviewers.refetch(), factories.refetch()]);
              })
            }
          >
            Deactivate
          </button>
        </Modal>
      )}
      {deleteAccount && (
        <Modal
          title="Mark account as deleted?"
          close={() => setDeleteAccount(null)}
        >
          <p>
            {deleteAccount.name}&apos;s access will end permanently. The account
            will remain in this list with a Deleted status, and its case and
            review history will stay linked to it.
          </p>
          <p>This account cannot be reactivated.</p>
          {error && <ErrorNote text={error} />}
          <div className="inline-actions">
            <button onClick={() => setDeleteAccount(null)}>Cancel</button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const result = await api<{
                    deleted: boolean;
                    card_cleanup_pending: boolean;
                  }>(
                    `/v1/admin/accounts/${deleteAccount.id}`,
                    token,
                    "DELETE",
                  );
                  setDeleteAccount(null);
                  if (deleteAccount.role === "factory_manager") {
                    setSelected("");
                  }
                  await Promise.all([
                    reviewers.refetch(),
                    managers.refetch(),
                    factories.refetch(),
                  ]);
                  if (result.card_cleanup_pending) {
                    setError(
                      "The account was deleted, but its stored ID image could not be removed. Contact an administrator to finish the cleanup.",
                    );
                  }
                })
              }
            >
              Mark as deleted
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ManagerDetail({
  id,
  token,
  factories,
  close,
  requestDelete,
  changed,
}: {
  id: string;
  token: string;
  factories: Factory[];
  close: () => void;
  requestDelete: (name: string) => void;
  changed: () => Promise<void>;
}) {
  const query = useQuery({
    queryKey: ["admin-application", id, token],
    queryFn: () =>
      api<Application>(`/v1/admin/manager-applications/${id}`, token),
  });
  const [factory, setFactory] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Blob | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!preview) {
      setUrl("");
      return;
    }
    const url = URL.createObjectURL(preview);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);
  const row = query.data;
  const selected = factory ?? row?.requested_factory_id ?? "";
  async function action(choice: string) {
    setBusy(true);
    setError("");
    try {
      if (choice === "preview") {
        const response = await fetch(
          apiBase() + `/v1/admin/manager-applications/${id}/id-card`,
          { headers: { Authorization: "Bearer " + token }, cache: "no-store" },
        );
        if (!response.ok) throw new Error("The office ID card is unavailable.");
        setPreview(await response.blob());
      } else if (choice === "cleanup") {
        await api(
          `/v1/admin/manager-applications/${id}/id-card`,
          token,
          "DELETE",
        );
        await changed();
      } else {
        await api(`/v1/admin/accounts/${id}/${choice}`, token, "POST", {
          factory_id: selected || null,
          reason: reason || null,
        });
        setPreview(null);
        await changed();
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Manager application" close={close}>
      {query.isLoading && <Busy />}
      {query.error && <ErrorNote text={message(query.error)} />}
      {row && (
        <div className="admin-form">
          <div>
            <strong>{row.full_name}</strong>
            <p>
              {row.email} · {row.phone || "Phone unavailable"}
            </p>
            <p>
              {row.job_title || "Factory Manager"} · {status(row.status)}
            </p>
          </div>
          <p>
            Submitted {dateText(row.created_at)}.{" "}
            {row.consent_at ? "Office ID consent recorded." : ""}
          </p>
          {row.id_card_review && (
            <section className="id-card-review" aria-label="Office ID review">
              <h3>Office ID review</h3>
              <div
                className={`id-card-check ${row.id_card_review.card_status === "readable" ? "ok" : "warn"}`}
              >
                <span>Card file</span>
                <strong>
                  {row.id_card_review.card_status === "readable"
                    ? "Readable card found"
                    : row.id_card_review.card_status === "missing"
                      ? "No card attached"
                      : "Card could not be read"}
                </strong>
              </div>
              <div
                className={`id-card-check ${row.id_card_review.name_status === "match" ? "ok" : "warn"}`}
              >
                <span>Applicant name</span>
                <strong>
                  {row.id_card_review.name_status === "match"
                    ? "Name found on card"
                    : row.id_card_review.name_status === "not_checked"
                      ? "Not checked"
                      : "Name not found on card text"}
                </strong>
              </div>
              <div
                className={`id-card-check ${row.id_card_review.number_status === "match" ? "ok" : "warn"}`}
              >
                <span>Office ID number</span>
                <strong>
                  {row.id_card_review.number_status === "match"
                    ? "Matches the application"
                    : row.id_card_review.number_status === "mismatch"
                      ? `Mismatch · card: ${row.id_card_review.extracted_number} · application: ${row.id_card_number}`
                      : row.id_card_review.number_status === "not_entered"
                        ? row.id_card_review.extracted_number
                          ? `Card says ${row.id_card_review.extracted_number}; no number entered in application`
                          : "No number entered in the application"
                        : "Could not verify the number from the card"}
                </strong>
              </div>
              <p className="hint">
                These checks are warnings for manual review. They do not approve
                or reject the application automatically.
              </p>
            </section>
          )}
          {row.requested_factory && (
            <p>
              Requested factory: {row.requested_factory.name} ·{" "}
              {row.requested_factory.address}
            </p>
          )}
          {row.factory_id && (
            <p>
              Assigned factory:{" "}
              {factories.find((f) => f.id === row.factory_id)?.name}
            </p>
          )}
          {row.id_card_number && (
            <p>Office ID card number: {row.id_card_number}</p>
          )}
          {row.membership_number && (
            <p>License or membership: {row.membership_number}</p>
          )}
          {row.reject_reason && <p>Rejection reason: {row.reject_reason}</p>}
          {row.card_cleanup_pending && (
            <button disabled={busy} onClick={() => void action("cleanup")}>
              Retry office ID deletion
            </button>
          )}
          {row.id_card_deleted_at && (
            <p>Office ID deleted {dateText(row.id_card_deleted_at)}.</p>
          )}
          {row.has_id_card && !preview && (
            <button disabled={busy} onClick={() => void action("preview")}>
              View office ID card
            </button>
          )}
          {row.has_id_card &&
            url &&
            (preview?.type === "application/pdf" ? (
              <object
                data={url}
                type="application/pdf"
                title="Office ID PDF"
                className="admin-card-preview"
                style={{ height: 400 }}
              >
                <a href={url} target="_blank" rel="noreferrer">
                  Open office ID PDF
                </a>
              </object>
            ) : (
              <img
                src={url}
                alt="Submitted office ID card"
                className="admin-card-preview"
              />
            ))}
          {row.status === "pending_approval" && (
            <>
              <label>
                Factory to approve
                <select
                  value={selected}
                  onChange={(e) => setFactory(e.target.value)}
                >
                  <option value="">Choose factory</option>
                  {factories.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              {row.active_manager_factory_ids.includes(selected) && (
                <p className="notice" role="status">
                  This factory already has an active manager.
                </p>
              )}
              <label>
                Rejection reason
                <textarea
                  maxLength={1500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="inline-actions">
                <button
                  className="primary"
                  disabled={busy || !selected}
                  onClick={() => void action("approve")}
                >
                  Approve
                </button>
                <button
                  className="danger"
                  disabled={busy || !reason.trim()}
                  onClick={() => void action("reject")}
                >
                  Reject
                </button>
              </div>
            </>
          )}
          {row.status === "active" && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => void action("deactivate")}
            >
              Deactivate manager
            </button>
          )}
          {row.status === "deactivated" && (
            <div className="inline-actions">
              <button
                className="primary"
                disabled={busy || !row.factory_id}
                onClick={() => void action("reactivate")}
                title={
                  row.factory_id
                    ? "Restore this same manager account and factory access."
                    : "This manager has no factory binding; assign one before reactivation."
                }
              >
                Reactivate manager
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() => requestDelete(row.full_name)}
              >
                Delete manager
              </button>
            </div>
          )}
        </div>
      )}
      {error && <ErrorNote text={error} />}
    </Modal>
  );
}
