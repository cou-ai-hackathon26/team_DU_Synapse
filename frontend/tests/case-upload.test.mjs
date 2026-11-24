import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { currentUploadDocuments } from "../lib/case-upload.ts";

const cap = (case_id) => ({ id: `cap-${case_id}`, case_id, role: "cap" });
test("second and third inspections can each add a CAP despite earlier inherited CAPs", () => {
  for (const [id, previous] of [["september", [cap("august")]], ["october", [cap("august"), cap("september")]]]) {
    const dossier = { case: { id }, documents: [...previous, { id: `inspection-${id}`, role: "inspection", case_id: id }] };
    assert.equal(currentUploadDocuments(dossier).find((d) => d.role === "cap"), undefined);
    dossier.documents.push(cap(id));
    assert.equal(currentUploadDocuments(dossier).filter((d) => d.role === "cap").length, 1);
    assert.equal(currentUploadDocuments(dossier).find((d) => d.role === "cap").case_id, id);
  }
});
test("both duplicate-CAP checks and revision options use only the current inspection", () => {
  const source = readFileSync(new URL("../components/documents.tsx", import.meta.url), "utf8");
  assert.match(source, /existingCap = uploadDocuments.find/);
  assert.match(source, /\{uploadDocuments\s*\.filter/);
});
