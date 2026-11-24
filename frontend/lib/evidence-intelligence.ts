import type { Case, Dossier, Outcome, Result, Run } from "./api";

export type OfficialEvidenceStatus =
  | "Supported"
  | "Unresolved"
  | "Contradictory"
  | "Insufficient Evidence";

export type EvidenceResult = Omit<Result, "claim"> & {
  claim: Result["claim"] & {
    facility?: string | null;
    location?: string | null;
    finding_id?: string | null;
  };
};

export const officialStatusColors: Record<OfficialEvidenceStatus, string> = {
  Supported: "#34d399",
  Unresolved: "#fbbf24",
  Contradictory: "#fb7185",
  "Insufficient Evidence": "#8b9bb4",
};

export function officialEvidenceStatus(
  outcome: Outcome,
): OfficialEvidenceStatus | null {
  switch (outcome) {
    case "supported":
      return "Supported";
    case "unresolved":
      return "Unresolved";
    case "contradicted":
      return "Contradictory";
    case "unsupported":
      return "Insufficient Evidence";
    default:
      return null;
  }
}

export function evidenceStatusCounts(results: EvidenceResult[]) {
  const counts: Record<OfficialEvidenceStatus, number> = {
    Supported: 0,
    Unresolved: 0,
    Contradictory: 0,
    "Insufficient Evidence": 0,
  };
  let unclassified = 0;
  for (const result of results) {
    const status = officialEvidenceStatus(result.outcome);
    if (status) counts[status] += 1;
    else unclassified += 1;
  }
  return { counts, classified: results.length - unclassified, unclassified };
}

export function authorizedFactories(cases: Case[]) {
  return [...new Set(cases.map((item) => item.factory.trim()).filter(Boolean))];
}

export function casesForFactory(cases: Case[], factory: string) {
  return cases.filter((item) => item.factory === factory);
}

export function latestReadableRun(dossier: Dossier): Run | undefined {
  return dossier.runs.find((run) =>
    ["complete", "partial"].includes(run.status),
  );
}
