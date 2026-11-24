import type { Doc, Version } from "./api";

type RecordVersion = Pick<
  Version,
  | "id"
  | "document_id"
  | "case_id"
  | "revision"
  | "status"
  | "issued_on"
  | "period_start"
  | "period_end"
>;

export function latestReadyVersions<T extends RecordVersion>(
  versions: T[],
): T[] {
  const latest = new Map<string, T>();
  for (const version of versions) {
    if (!["ready", "partial"].includes(version.status)) continue;
    if ((latest.get(version.document_id)?.revision ?? 0) < version.revision)
      latest.set(version.document_id, version);
  }
  return [...latest.values()];
}

export function inspectionMonths(
  documents: Pick<Doc, "id" | "role">[],
  versions: RecordVersion[],
): string[] {
  const inspections = new Set(
    documents.filter((doc) => doc.role === "inspection").map((doc) => doc.id),
  );
  const months = new Set<string>();
  for (const version of versions) {
    if (
      !inspections.has(version.document_id) ||
      !["ready", "partial"].includes(version.status)
    )
      continue;
    const from = (
      version.period_start ||
      version.period_end ||
      version.issued_on
    )?.slice(0, 7);
    const to = (
      version.period_end ||
      version.period_start ||
      version.issued_on
    )?.slice(0, 7);
    if (
      !from ||
      !to ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(from) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(to)
    )
      continue;
    const index = (month: string) => {
      const [year, number] = month.split("-").map(Number);
      return year * 12 + number - 1;
    };
    for (let i = index(from); i <= index(to); i++) {
      months.add(
        `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`,
      );
    }
  }
  return [...months].sort().reverse();
}

/** Date-based suggestions; reviewers can add records needed for wider claims. */
export function documentsForMonth(
  documents: Pick<Doc, "id" | "role">[],
  versions: RecordVersion[],
  month: string,
  scheduledOn?: string | null,
  priorCaseIds: string[] = [],
): string[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const start = `${month}-01`;
  const [year, number] = month.split("-").map(Number);
  const end = `${month}-${new Date(Date.UTC(year, number, 0)).getUTCDate()}`;
  const role = new Map(documents.map((doc) => [doc.id, doc.role]));
  const firstDate = (v: RecordVersion) =>
    v.period_start || v.period_end || v.issued_on;
  const lastDate = (v: RecordVersion) =>
    v.period_end || v.period_start || v.issued_on;
  const available = versions.filter((v) => {
    const date = firstDate(v);
    const contextual = ["sop", "cap"].includes(role.get(v.document_id) || "");
    return (
      (!date || date <= end) &&
      (!contextual || !v.issued_on || v.issued_on <= end)
    );
  });
  const current = latestReadyVersions(
    available.filter((v) => {
      const from = firstDate(v),
        to = lastDate(v);
      return !!from && !!to && from <= end && to >= start;
    }),
  );
  const selected = new Map(current.map((v) => [v.document_id, v]));
  const priorCases = new Set(priorCaseIds);
  const priorVersions = latestReadyVersions(
    versions.filter((v) => priorCases.has(v.case_id || "")),
  );
  for (const v of priorVersions) selected.set(v.document_id, v);
  const context = latestReadyVersions(
    available.filter((v) => {
      const kind = role.get(v.document_id);
      return kind === "sop" || kind === "cap";
    }),
  );
  for (const v of context)
    if (!selected.has(v.document_id)) selected.set(v.document_id, v);
  if (scheduledOn?.slice(0, 7) === month) {
    // A plan submitted in response to a scheduled visit can be issued later.
    const plans = versions.filter((v) => role.get(v.document_id) === "cap");
    for (const v of latestReadyVersions(plans)) selected.set(v.document_id, v);
  }
  const earlier = latestReadyVersions(
    available.filter((v) => {
      const date = lastDate(v);
      return role.get(v.document_id) === "inspection" && !!date && date < start;
    }),
  );
  const previousDate = earlier
    .map(lastDate)
    .filter((date): date is string => !!date)
    .sort()
    .at(-1);
  for (const v of earlier) {
    if (lastDate(v) === previousDate && !selected.has(v.document_id))
      selected.set(v.document_id, v);
  }
  return [...selected.values()].map((v) => v.id);
}
