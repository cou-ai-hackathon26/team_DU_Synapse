"use client";
import { useEffect, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  ChevronRight,
  Files,
  FolderOpen,
  LibraryBig,
  LogOut,
} from "lucide-react";
import {
  api,
  Case,
  Catalog,
  Config,
  Dossier,
  dateText,
  message,
  roles,
  ReviewerNotification,
} from "@/lib/api";
import { Busy, DocIcon, ErrorNote, Modal, PasswordField, Tag } from "./ui";
import { Viewer, Preview } from "./viewer";
import { Documents, FactoryDocuments } from "./documents";
import { Analysis } from "./analysis";
import { CaseOverview } from "./case-overview";
import { RunHistory } from "./run-history";
import { HazardHistory } from "./hazard-history";
import { CapReview } from "./cap-review";
import { AdminWorkspace } from "./admin-workspace";
import type { Factory } from "./onboarding";
import { AccountMenu } from "./account-menu";
import { CorrectiveWork } from "./corrective-work";
import { sampleCatalog } from "@/lib/samples";
import type { components } from "@/lib/schema";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
});
export function Workspace({ basePath = "/workspace" }: { basePath?: string }) {
  return (
    <QueryClientProvider client={qc}>
      <App basePath={basePath} />
    </QueryClientProvider>
  );
}

function App({ basePath }: { basePath: string }) {
  const router = useRouter(),
    params = useSearchParams(),
    cache = useQueryClient();
  const cid = params.get("case") || "",
    requestedView = params.get("view") || (cid ? "overview" : "cases");
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => api<Config>("/v1/config"),
  });
  const [auth, setAuth] = useState<SupabaseClient | null>(null),
    [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [dialog, setDialog] = useState<"account" | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [notificationsOpen, setNotificationsOpen] = useState(false);
  useEffect(() => {
    if (!config.data?.publishable_key) {
      if (!config.isLoading) setRestoring(false);
      return;
    }
    const client = getSupabaseBrowserClient(config.data);
    setAuth(client);
    const { data } = client.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setRestoring(false);
    });
    return () => data.subscription.unsubscribe();
  }, [config.data, config.isLoading]);
  useEffect(() => {
    if (!restoring && !config.isLoading && !session) router.replace("/login");
  }, [config.isLoading, restoring, router, session]);
  const token = session?.access_token;
  const identity = useQuery({
    queryKey: ["identity", token],
    queryFn: () =>
      api<components["schemas"]["AccountProfile"]>("/v1/me", token),
    enabled: !!token,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const profile = identity.data;
  const role = profile?.role;
  const accountName =
    profile?.full_name?.trim() || session?.user.email || "Account";
  const isManager = role === "factory_manager";
  const reviewerNotifications = useQuery({
    queryKey: ["reviewer-notifications", token],
    queryFn: () => api<ReviewerNotification[]>("/v1/notifications", token),
    enabled: role === "reviewer",
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const assigned = useQuery({
    queryKey: ["assigned-factories", session?.user.id],
    queryFn: () =>
      api<{ factories: Factory }[]>("/v1/reviewer/factories", token),
    enabled: role === "reviewer",
  });
  const managerWork = useQuery({
    queryKey: ["manager-work", session?.user.id],
    queryFn: () =>
      api<{
        factory: Factory;
        inspections: {
          case_id: string;
          title: string;
          inspection_on: string;
          reviewer_name: string | null;
          organization: string | null;
        }[];
        tasks: {
          id: string;
          case_id: string;
          title: string;
          due_on: string;
          status: string;
        }[];
      }>("/v1/manager/work", token),
    enabled: isManager,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
  });
  const view = isManager
    ? cid
      ? requestedView === "documents"
        ? "documents"
        : "corrective"
      : "cases"
    : requestedView;
  const cases = useQuery({
    queryKey: ["cases", session?.user.id],
    queryFn: () => api<Case[]>("/v1/cases", token),
    enabled: !!role && role !== "admin",
  });
  const dossier = useQuery({
    queryKey: ["case", session?.user.id, cid],
    queryFn: () => api<Dossier>("/v1/cases/" + cid, token),
    enabled: !!role && role !== "admin" && !!cid,
    refetchOnWindowFocus: true,
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => ["queued", "running"].includes(j.state)) ||
      (isManager && q.state.data?.versions.some((v) => v.status === "queued"))
        ? 1700
        : isManager && q.state.data?.case.inspection_on
          ? 15000
          : false,
  });
  function go(v: string, id = "", run = "", item = "") {
    const p = new URLSearchParams();
    if (id) p.set("case", id);
    if (v !== "cases") p.set("view", v);
    if (run) p.set("run", run);
    if (item) p.set("item", item);
    router.push(basePath + (p.size ? "?" + p : ""));
  }
  async function refresh() {
    await Promise.all([cases.refetch(), ...(cid ? [dossier.refetch()] : [])]);
  }
  async function signout() {
    await auth?.auth.signOut({ scope: "local" });
    cache.removeQueries({
      predicate: (q) => !["config"].includes(String(q.queryKey[0])),
    });
    setDialog(null);
    router.replace("/login");
  }
  async function openReviewerNotification(item: ReviewerNotification) {
    try {
      if (!item.read_at)
        await api(`/v1/notifications/${item.id}/read`, token, "POST");
      await reviewerNotifications.refetch();
    } finally {
      setNotificationsOpen(false);
      go("documents", item.case_id);
    }
  }
  async function openReviewerCase(caseId: string) {
    const unread = (reviewerNotifications.data || []).filter(
      (item) => item.case_id === caseId && !item.read_at,
    );
    if (unread.length) {
      await Promise.allSettled(
        unread.map((item) =>
          api(`/v1/notifications/${item.id}/read`, token, "POST"),
        ),
      );
      await reviewerNotifications.refetch();
    }
    go("overview", caseId);
  }
  const sample = sampleCatalog;
  const current = token && cid ? dossier.data : undefined;
  const relatedInspectionCases = current?.case.follow_up_root_id
    ? (cases.data || [])
        .filter(
          (item) =>
            item.follow_up_root_id === current.case.follow_up_root_id &&
            item.id !== current.case.id &&
            !!item.inspection_on &&
            (!current.case.inspection_on ||
              item.inspection_on < current.case.inspection_on),
        )
        .sort(
          (left, right) =>
            (left.follow_up_number || 0) - (right.follow_up_number || 0),
        )
    : [];
  const earlierDossiers = useQueries({
    queries: relatedInspectionCases.map((item) => ({
      queryKey: ["case", session?.user.id, item.id],
      queryFn: () => api<Dossier>("/v1/cases/" + item.id, token),
      enabled:
        !!token &&
        current?.role === "reviewer" &&
        current.case.inspection_kind === "follow_up",
      staleTime: 30_000,
    })),
  });
  if (restoring || (token && identity.isPending))
    return (
      <main className="boot">
        <Busy />
      </main>
    );
  if (!session || identity.isError) {
    if (!session && !identity.isError) {
      return (
        <main className="boot">
          <Busy />
        </main>
      );
    }
    const signIn =
      params.get("sign-in") === "factory-manager"
        ? "factory_manager"
        : "reviewer";
    return (
      <main className="entry-page">
        <section className="panel entry-panel">
          <h1>Sign in to SafetyProof AI</h1>
          <AccountMenu current={signIn} />
          {signIn === "reviewer" && params.get("password") === "updated" && (
            <p>Your password is set. Sign in to continue.</p>
          )}
          <Login
            auth={auth}
            restoring={restoring}
            email={params.get("email") || ""}
            error={
              identity.error
                ? message(identity.error)
                : config.error
                  ? message(config.error)
                  : undefined
            }
            key={signIn}
            workspace={signIn}
          />
        </section>
      </main>
    );
  }
  if (role === "admin" && token) {
    const view =
      requestedView === "reviewers" ||
      requestedView === "manager-applications" ||
      requestedView === "factory-assignments" ||
      requestedView === "scheduled-inspections"
        ? requestedView
        : "factories";
    return (
      <AdminWorkspace token={token} view={view} />
    );
  }
  return (
    <div className="unified-workspace">
      <div className="workspace-context-actions">
            {role === "reviewer" && (
              <div className="notification-menu">
                <button
                  className="notification-trigger icon-button"
                  aria-label={`Notifications${
                    reviewerNotifications.data?.filter((item) => !item.read_at)
                      .length
                      ? `, ${reviewerNotifications.data.filter((item) => !item.read_at).length} unread`
                      : ""
                  }`}
                  aria-expanded={notificationsOpen}
                  onClick={() => setNotificationsOpen((open) => !open)}
                >
                  <Bell size={18} />
                  {!!reviewerNotifications.data?.some((item) => !item.read_at) && (
                    <span className="notification-count">
                      {reviewerNotifications.data.filter((item) => !item.read_at)
                        .length}
                    </span>
                  )}
                </button>
                {notificationsOpen && (
                  <div className="notification-popover">
                    <div className="notification-popover-head">
                      <b>Notifications</b>
                      <button
                        className="text-button"
                        onClick={() => setNotificationsOpen(false)}
                      >
                        Close
                      </button>
                    </div>
                    {reviewerNotifications.isLoading ? (
                      <p className="empty-text">Loading notifications…</p>
                    ) : reviewerNotifications.error ? (
                      <p className="error-text">
                        {message(reviewerNotifications.error)}
                      </p>
                    ) : reviewerNotifications.data?.length ? (
                      <div className="notification-list">
                        {reviewerNotifications.data.map((item) => (
                          <button
                            className={
                              "notification-item " +
                              (!item.read_at ? "unread" : "")
                            }
                            key={item.id}
                            onClick={() => void openReviewerNotification(item)}
                          >
                            <span className="notification-item-dot" />
                            <span>
                              <b>{item.title}</b>
                              <small>{item.body}</small>
                              <small>
                                {new Intl.DateTimeFormat("en-GB", {
                                  day: "numeric",
                                  month: "short",
                                  year: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                }).format(new Date(item.created_at))}
                              </small>
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="empty-text">No notifications yet.</p>
                    )}
                  </div>
                )}
              </div>
            )}
            <button className="v2-button secondary workspace-profile-button" onClick={() => setDialog("account")}>
              Account details
            </button>
      </div>
        <main className="content unified-workspace-content">
          {view === "library" ? (
            <>
              <div className="page-head">
                <div>
                  <span className="eyebrow">
                    <LibraryBig size={15} /> Source materials
                  </span>
                  <h1>Document library</h1>
                  <p>
                    Open the original files from the fictional factory case.
                  </p>
                </div>
              </div>
              <SampleFiles sample={sample} preview={setPreview} />
            </>
          ) : cid && token ? (
            <>
              {current ? (
                <>
                  <div className="page-head case-head">
                    <div>
                      <button className="backlink" onClick={() => go("cases")}>
                        {isManager ? "Factory cases" : "Review cases"}{" "}
                        <ChevronRight size={13} />
                      </button>
                      <h1>{current.case.title}</h1>
                      <p>
                        {current.case.factory} <span className="middot">·</span>{" "}
                        {dateText(current.case.period_start)} –{" "}
                        {dateText(current.case.period_end)}
                      </p>
                      {current.case.inspection_on && (
                        <p>
                          Inspection scheduled for{" "}
                          {dateText(current.case.inspection_on)}
                        </p>
                      )}
                    </div>
                    <Tag tone={current.case.archived ? "" : "green"}>
                      {current.case.archived
                        ? "Archived"
                        : current.role === "reviewer"
                          ? "Reviewer access"
                          : current.role === "manager"
                            ? "Factory Manager"
                            : "View only"}
                    </Tag>
                  </div>
                  {current.role === "reviewer" &&
                    current.case.inspection_kind === "follow_up" && (
                      <section className="panel panel-pad" aria-label="Related inspection files">
                        <h2>Earlier inspection files</h2>
                        <p>
                          Factory documents from earlier inspections in this
                          series are shown here for reference. They remain
                          stored with their original inspection.
                        </p>
                        {relatedInspectionCases.map((item, index) => {
                          const earlier = earlierDossiers[index];
                          const earlierDossier = earlier?.data;
                          return (
                            <div className="follow-up-source" key={item.id}>
                              <button
                                className="file-row"
                                onClick={() => go("documents", item.id)}
                              >
                                <span className="row-main">
                                  <b>{item.title}</b>
                                  <small>
                                    {dateText(item.inspection_on)}
                                    {(item.follow_up_number ?? 0) > 0
                                      ? ` · Follow-up ${item.follow_up_number ?? 0}`
                                      : " · Initial inspection"}
                                  </small>
                                </span>
                                <ChevronRight size={16} />
                              </button>
                              {earlier?.isLoading ? (
                                <p className="empty-text">Loading earlier factory documents…</p>
                              ) : earlier?.error ? (
                                <ErrorNote text={message(earlier.error)} />
                              ) : earlierDossier?.documents.length ? (
                                <div className="follow-up-document-list">
                                  {earlierDossier.documents.map((doc) => {
                                    const version = earlierDossier.versions
                                      .filter(
                                        (entry) =>
                                          entry.document_id === doc.id &&
                                          ["ready", "partial"].includes(entry.status),
                                      )
                                      .sort((a, b) => b.revision - a.revision)[0];
                                    return (
                                      <div className="follow-up-document" key={doc.id}>
                                        <span>
                                          <b>{doc.title}</b>
                                          <small>
                                            {roles[doc.role]}
                                            {version
                                              ? ` · Revision ${version.revision} · ${version.page_count} pages`
                                              : " · No readable report available"}
                                          </small>
                                        </span>
                                        {version && (
                                          <button
                                            className="v2-button secondary"
                                            onClick={() =>
                                              setPreview({
                                                title: doc.title,
                                                version: version.id,
                                              })
                                            }
                                          >
                                            Open report
                                          </button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="empty-text">
                                  No factory documents were uploaded to this earlier inspection.
                                </p>
                              )}
                            </div>
                          );
                        })}
                        {!relatedInspectionCases.length && (
                          <p className="empty-text">
                            Earlier inspection files are not available for this case.
                          </p>
                        )}
                      </section>
                    )}
                  <div
                    className="tabs"
                    role="navigation"
                    aria-label="Case navigation"
                  >
                    {(current.role === "manager"
                      ? [
                          ...(current.case.inspection_on
                            ? [["documents", "Documents"]]
                            : []),
                          ["corrective", "Corrective work"],
                        ]
                      : [
                          ["overview", "Overview"],
                          ["documents", "Documents"],
                          ["review", "Review queue"],
                          ["cap", "CAP matching"],
                          ["history", "Run history"],
                          ...(current.role === "reviewer"
                            ? [["hazards", "Hazard history"], ["corrective", "Corrective work"]]
                            : []),
                        ]
                    ).map(([key, text]) => (
                      <button
                        key={key}
                        className={view === key ? "sel" : ""}
                        onClick={() => go(key, cid)}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                  {current.role === "manager" &&
                  current.case.inspection_on &&
                  view === "documents" ? (
                    <FactoryDocuments
                      key={cid}
                      dossier={current}
                      token={token}
                      preview={setPreview}
                      refresh={refresh}
                    />
                  ) : view === "corrective" || current.role === "manager" ? (
                    <CorrectiveWork
                      key={cid}
                      dossier={current}
                      token={token}
                      preview={setPreview}
                      refresh={refresh}
                    />
                  ) : view === "overview" ? (
                    <CaseOverview
                      dossier={current}
                      token={token}
                      open={(v, r, i) => go(v, cid, r, i)}
                    />
                  ) : view === "hazards" && current.role === "reviewer" ? (
                    <HazardHistory key={cid} caseId={cid} token={token!} preview={setPreview} />
                  ) : view === "history" ? (
                    <RunHistory
                      key={cid}
                      runs={current.runs}
                      token={token}
                      open={(r, i) => go("review", cid, r, i)}
                    />
                  ) : view === "cap" ? (
                    <CapReview
                      key={cid}
                      dossier={current}
                      token={token}
                      runId={params.get("run")}
                      findingId={params.get("item")}
                      preview={setPreview}
                      documents={() => go("documents", cid)}
                      review={(r, i) => go("review", cid, r, i)}
                    />
                  ) : view === "review" ? (
                    <Analysis
                      key={cid}
                      dossier={current}
                      token={token}
                      runId={params.get("run")}
                      itemId={params.get("item")}
                      go={(r, i) => go("review", cid, r, i)}
                      openCap={(r, i) => go("cap", cid, r, i)}
                      preview={setPreview}
                      refresh={refresh}
                    />
                  ) : (
                    <Documents
                      key={cid}
                      dossier={current}
                      token={token}
                      configured={!!config.data?.ai_configured}
                      preview={setPreview}
                      refresh={refresh}
                      openedRun={(id) => go("review", cid, id)}
                      onRemoved={() => go("cases")}
                      owner={session?.user.id === current.case.created_by}
                    />
                  )}
                </>
              ) : dossier.error ? (
                <ErrorNote text={message(dossier.error)} />
              ) : (
                <Busy text="Opening review case…" />
              )}
            </>
          ) : (
            <>
              <div className="page-head">
                <div>
                  <span className="eyebrow">
                    <FolderOpen size={15} />{" "}
                    {isManager
                      ? "Factory Manager workspace"
                      : "Reviewer workspace"}
                  </span>
                  <h1>{isManager ? "Factory cases" : "Review cases"}</h1>
                  <p>
                    {isManager
                      ? "See the cases shared with your factory and submit corrective evidence."
                      : "Cross-check factory safety reports against their own evidence."}
                  </p>
                </div>
              </div>
              {isManager && (
                <section className="panel" aria-label="Inspection notices">
                  <div className="section-head">
                    <h2>Inspection notices</h2>
                    <Tag>{managerWork.data?.inspections?.length ?? 0}</Tag>
                  </div>
                  {managerWork.data?.inspections?.length === 0 && (
                    <p className="empty-text">
                      No inspections have been scheduled for your factory.
                    </p>
                  )}
                  {managerWork.data?.inspections?.map((inspection) => (
                    <button
                      key={inspection.case_id}
                      className="file-row"
                      onClick={() => go("documents", inspection.case_id)}
                    >
                      <span className="row-main">
                        <b>{inspection.title}</b>
                        <small>
                          {dateText(inspection.inspection_on)} ·{" "}
                          {inspection.organization ||
                            "Organization not recorded"}
                        </small>
                        {inspection.reviewer_name && (
                          <small>{inspection.reviewer_name}</small>
                        )}
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </section>
              )}
              {isManager && (
                <section className="panel">
                  <div className="section-head">
                    <div>
                      <h2>Corrective tasks</h2>
                      <p>
                        {managerWork.data?.factory.name ||
                          "Your assigned factory"}
                      </p>
                    </div>
                  </div>
                  {managerWork.isLoading && <Busy />}
                  {managerWork.error && (
                    <ErrorNote text={message(managerWork.error)} />
                  )}
                  {managerWork.data?.tasks.length === 0 && (
                    <p className="empty-text">
                      No corrective tasks assigned yet.
                    </p>
                  )}
                  {managerWork.data?.tasks.map((task) => (
                    <button
                      className="file-row"
                      key={task.id}
                      onClick={() => go("corrective", task.case_id)}
                    >
                      <span className="row-main">
                        <b>{task.title}</b>
                        <small>Due {dateText(task.due_on)}</small>
                      </span>
                      <Tag>{task.status.replaceAll("_", " ")}</Tag>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </section>
              )}
              {session && (
                <section className="panel cases-panel">
                  <div className="section-head">
                    <h2>Your cases</h2>
                    <Tag>{cases.data?.length ?? 0}</Tag>
                  </div>
                  {cases.isLoading ? (
                    <Busy />
                  ) : cases.error ? (
                    <ErrorNote text={message(cases.error)} />
                  ) : cases.data?.length ? (
                    cases.data.map((c) => (
                      <button
                        className="file-row"
                        key={c.id}
                        onClick={() => {
                          if (role === "reviewer") {
                            void openReviewerCase(c.id);
                            return;
                          }
                          go(
                            isManager
                              ? c.inspection_on
                                ? "documents"
                                : "corrective"
                              : "overview",
                            c.id,
                          );
                        }}
                      >
                        <span className="doc-icon inspection">
                          <FolderOpen size={21} />
                        </span>
                        <span className="row-main">
                          <b>{c.title}</b>
                          <small>{c.factory}</small>
                          {role === "reviewer" &&
                            c.inspection_on &&
                            c.reviewer_id !== session?.user.id && (
                              <small>Related inspection files shared with you</small>
                            )}
                          {role === "reviewer" &&
                            reviewerNotifications.data?.some(
                              (item) =>
                                item.case_id === c.id && !item.read_at,
                            ) && (
                              <small className="case-notification-indicator">
                                <span aria-hidden="true" />
                                New factory document
                              </small>
                            )}
                        </span>
                        <span className="muted">
                          {c.archived ? "Archived" : dateText(c.created_at)}
                        </span>
                        <ChevronRight size={17} />
                      </button>
                    ))
                  ) : (
                    <p className="empty-text">
                      {isManager
                        ? "Cases created for your factory will appear here."
                        : "No cases have been assigned to you yet."}
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      {preview && (
        <Viewer item={preview} token={token} close={() => setPreview(null)} />
      )}
      {dialog === "account" && (
        <Modal title="Account settings" close={() => setDialog(null)}>
          <dl className="reviewer-fields account-details">
            <dt>Full name</dt>
            <dd>{accountName}</dd>
            <dt>Email</dt>
            <dd>{profile?.email || session.user.email}</dd>
            <dt>Role</dt>
            <dd>
              {role === "factory_manager"
                ? "Factory Manager"
                : role === "reviewer"
                  ? "Reviewer / Auditor"
                  : role || "Not recorded"}
            </dd>
            {role === "reviewer" && (
              <>
                <dt>Organization</dt>
                <dd>{profile?.organization || "Not recorded"}</dd>
                <dt>Reviewer type</dt>
                <dd>{profile?.role_type || "Not recorded"}</dd>
                <dt>Assigned factories</dt>
                <dd>
                  {assigned.isPending
                    ? "Loading…"
                    : assigned.isError
                      ? "Unavailable"
                      : assigned.data
                          ?.map(({ factories }) => factories.name)
                          .join(", ") || "No factory assignments"}
                </dd>
              </>
            )}
            {role === "factory_manager" && (
              <>
                <dt>Organization</dt>
                <dd>
                  {profile?.organization ||
                    managerWork.data?.factory.name ||
                    (managerWork.isPending ? "Loading…" : "Not recorded")}
                </dd>
                <dt>Factory</dt>
                <dd>
                  {managerWork.data?.factory.name ||
                    (managerWork.isPending ? "Loading…" : "Unavailable")}
                </dd>
                <dt>Factory address</dt>
                <dd>
                  {managerWork.data?.factory.address ||
                    (managerWork.isPending ? "Loading…" : "Unavailable")}
                </dd>
                <dt>Phone</dt>
                <dd>{profile?.phone || "Not recorded"}</dd>
                <dt>Job title</dt>
                <dd>{profile?.job_title || "Factory Manager"}</dd>
                <dt>Office ID card number</dt>
                <dd>{profile?.id_card_number || "Not recorded"}</dd>
                <dt>Factory license / membership number</dt>
                <dd>{profile?.membership_number || "Not recorded"}</dd>
                <dt>Office ID consent</dt>
                <dd>
                  {profile?.consent_at
                    ? `Recorded ${dateText(profile.consent_at)}`
                    : "Not recorded"}
                </dd>
              </>
            )}
            {profile?.status && (
              <>
                <dt>Account status</dt>
                <dd className="account-status">
                  {profile.status.replaceAll("_", " ")}
                </dd>
              </>
            )}
            {profile?.created_at && (
              <>
                <dt>Member since</dt>
                <dd>{dateText(profile.created_at)}</dd>
              </>
            )}
          </dl>
          <button onClick={signout}>
            <LogOut size={16} />
            Sign out
          </button>
        </Modal>
      )}
    </div>
  );
}

function SampleFiles({
  sample,
  preview,
  compact = false,
}: {
  sample: Catalog;
  preview: (p: Preview) => void;
  compact?: boolean;
}) {
  return (
    <section className="panel library-panel">
      <div className="section-head">
        <div>
          <h2>{compact ? "Factory documents" : sample.title}</h2>
          <p>Synthetic records</p>
        </div>
        <span className="file-count">
          <Files size={15} />
          {sample.documents.length} files
        </span>
      </div>
      <div className="file-table-head">
        <span>Document</span>
        <span className="factory-heading">Factory</span>
        <span>Source format</span>
        <span className="issued-heading">Issued</span>
        <span />
      </div>
      {sample.documents.map((d) => (
        <button
          key={d.filename}
          className="doc-row"
          onClick={() => preview({ title: d.title, sample: d.filename })}
        >
          <span className="file-title">
            <DocIcon role={d.role} />
            <span>
              <b>{d.title}</b>
              <small>{roles[d.role]}</small>
            </span>
          </span>
          <span className="file-factory">
            <span className="file-factory-label">Factory · </span>
            {sample.factory}
          </span>
          <span className="file-format">
            {d.scan ? "Bangla scan" : "Digital PDF"}
          </span>
          <span className="file-date">{dateText(d.issued_on)}</span>
          <ArrowUpRight size={16} />
        </button>
      ))}
    </section>
  );
}

function Login({
  auth,
  restoring,
  email,
  error,
  workspace,
}: {
  auth: SupabaseClient | null;
  restoring: boolean;
  email: string;
  error?: string;
  workspace: "factory_manager" | "reviewer";
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setErr("");
    try {
      const session = await api<{
        access_token: string;
        refresh_token: string;
      }>("/v1/login", undefined, "POST", {
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
        workspace,
      });
      const { error } = await auth.auth.setSession(session);
      if (error) throw error;
    } catch (error) {
      setErr(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form id="sign-in" method="post" autoComplete="on" onSubmit={submit}>
      {workspace === "reviewer" && (
        <p className="hint">Administrators sign in here too.</p>
      )}
      <label htmlFor="sign-in-email">
        Email
        <input
          id="sign-in-email"
          name="email"
          type="email"
          required
          autoComplete="username"
          defaultValue={email}
        />
      </label>
      <PasswordField id="sign-in-password" />
      {(err || error || (!auth && !restoring)) && (
        <ErrorNote
          text={err || error || "Workspace authentication is unavailable."}
        />
      )}
      <button className="primary" disabled={busy || !auth}>
        Sign in <ArrowRight size={15} />
      </button>
    </form>
  );
}
