import type { Dossier } from "./api";

// Follow-up dossiers also carry earlier inspections' documents for reference.
// Those records must never block a new CAP or become this case's revision target.
export function currentUploadDocuments(dossier: Pick<Dossier, "case" | "documents">) {
  return dossier.documents.filter((doc) => !doc.case_id || doc.case_id === dossier.case.id);
}
