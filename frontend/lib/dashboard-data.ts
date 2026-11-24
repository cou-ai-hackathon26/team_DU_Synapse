import type { Dossier, Doc, Run } from "./api";
import { evidenceStatusCounts, latestReadableRun, officialStatusColors, type EvidenceResult } from "./evidence-intelligence";

export type CorrectiveBoard = {
  tasks: { id: string; title: string; status: string; case_id?: string }[];
  events: { id: string; action: string; created_at: string; task_id: string; case_id?: string }[];
};
export type RunSnapshot = { run: Run; results: EvidenceResult[] | null; error: string };
export type DashboardData = { dossier: Dossier; documents: Doc[] | null; documentError: string; results: EvidenceResult[]; resultsError: string; history: RunSnapshot[]; historyRestricted: boolean; board: CorrectiveBoard | null; boardError: string };
export type ReadDashboard = <T>(path: string) => Promise<T>;

function failure(caught: unknown) {
  return caught && typeof caught === "object" && "message" in caught && typeof caught.message === "string" ? caught.message : "Request failed.";
}

export function caseDocuments(dossier: Dossier): Doc[] | null {
  // Existing manager RLS exposes documents only for scheduled inspections.
  if (dossier.role === "manager" && !dossier.case.inspection_on) return null;
  return [...new Map(dossier.documents
    .filter((doc) => !(doc as Doc & { case_id?: string }).case_id || (doc as Doc & { case_id?: string }).case_id === dossier.case.id)
    .map((doc) => [doc.id, doc])).values()];
}

export async function loadDashboardData(dossier: Dossier, read: ReadDashboard): Promise<DashboardData> {
  const historyRestricted = dossier.role === "manager";
  const runs = (historyRestricted ? [] : [...dossier.runs]).filter((r) => ["complete", "partial"].includes(r.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8);
  let boardError = "";
  const [history, board] = await Promise.all([
    Promise.all(runs.map(async (run): Promise<RunSnapshot> => {
      try { return { run, results: await read<EvidenceResult[]>(`/v1/runs/${run.id}/results`), error: "" }; }
      catch (caught) { return { run, results: null, error: `Results unavailable for this snapshot: ${failure(caught)}` }; }
    })),
    dossier.role === "viewer" ? Promise.resolve(null) : read<CorrectiveBoard>(`/v1/cases/${dossier.case.id}/corrective-work`).catch((caught) => { boardError = `Corrective work unavailable: ${failure(caught)}`; return null; }),
  ]);
  const current = history.find((item) => item.run.id === latestReadableRun(dossier)?.id);
  const documents = caseDocuments(dossier);
  const scopedBoard = board ? {
    tasks: [...new Map(board.tasks.filter((t) => !t.case_id || t.case_id === dossier.case.id).map((t) => [t.id, t])).values()],
    events: [...new Map(board.events.filter((e) => !e.case_id || e.case_id === dossier.case.id).map((e) => [e.id, e])).values()],
  } : null;
  return { dossier, documents, documentError: documents === null ? "Document access is unavailable for managers in unscheduled cases under existing permissions." : "",
    results: current?.results ?? [], resultsError: current?.error ?? "", history, historyRestricted, board: scopedBoard, boardError };
}

export function dashboardMetrics(data: DashboardData | null, loading: boolean) {
  const unavailable = loading ? "Loading…" : "Unavailable";
  return [
    { label: "Authorized documents", value: data?.documents?.length ?? null, message: loading ? unavailable : data?.documentError || "Selected case only" },
    { label: "Corrective tasks", value: data?.board?.tasks.length ?? null, message: loading ? unavailable : data?.boardError || "Selected case only" },
    { label: "Work updates", value: data?.board?.events.length ?? null, message: loading ? unavailable : data?.boardError || "Recorded events in selected case" },
  ].map((metric) => ({ ...metric, display: loading ? unavailable : metric.value === null ? "Unavailable" : metric.value }));
}

export function dashboardDistribution(data: Pick<DashboardData, "results" | "board" | "dossier">) {
  if (data.results.length) {
    const summary = evidenceStatusCounts(data.results);
    return {
      title: "Evidence distribution", countTitle: "Review categories", unit: "statements",
      note: "Published assessments from the selected run, including statements awaiting review or assessment.",
      values: [
        ...Object.entries(summary.counts).map(([label, value]) => ({ label, value, color: officialStatusColors[label as keyof typeof officialStatusColors] })),
        { label: "Needs review", value: data.results.filter((r) => r.outcome === "needs_review").length, color: "#a78bfa" },
        { label: "Not assessed", value: data.results.filter((r) => r.outcome === "not_assessed").length, color: "#94a3b8" },
      ],
    };
  }
  const documents = caseDocuments(data.dossier);
  const records = (documents ?? []).map((d) => d.role === "cap" ? "CAP" : d.role.replaceAll("_", " "));
  const counts = new Map<string, number>();
  records.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1));
  const colors = ["#2b929c", "#a78bfa", "#fbbf24", "#34d399", "#fb7185", "#94a3b8"];
  return {
    title: "Authorized document types",
    countTitle: "Document counts", unit: "documents",
    note: data.dossier.role === "manager" ? "Verification results are reviewer-restricted. These are authorized selected-case documents, not AI findings." : "These are selected-case document counts. No published assessments were loaded; this does not establish that no findings exist.",
    values: [...counts].map(([label, value], i) => ({ label, value, color: colors[i % colors.length] })),
  };
}
