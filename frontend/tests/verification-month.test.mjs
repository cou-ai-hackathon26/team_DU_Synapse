import assert from "node:assert/strict";
import test from "node:test";
import {
  documentsForMonth,
  inspectionMonths,
  verificationMonthOptions,
  verificationSelection,
} from "../lib/verification-month.ts";

function record(id, role, from, to = from, extra = {}) {
  return {
    document: { id, role },
    version: {
      id: `${id}-v1`,
      document_id: id,
      revision: 1,
      status: "ready",
      issued_on: to,
      period_start: from,
      period_end: to,
      ...extra,
    },
  };
}
function select(records, month) {
  return documentsForMonth(
    records.map((r) => r.document),
    records.map((r) => r.version),
    month,
  ).sort();
}
const records = [
  record("march", "inspection", "2026-03-01", "2026-03-06"),
  record("april", "inspection", "2026-04-01", "2026-04-30"),
  record("incident", "incident", "2026-04-01", "2026-04-30"),
  record("sop", "sop", null, null, { issued_on: "2026-01-02" }),
  record("cap", "cap", null, null, { issued_on: "2026-03-12" }),
];

test("month choices come only from readable inspection reports", () => {
  const extra = [
    record("future", "inspection", "2027-06-01", "2027-06-30", {
      status: "queued",
    }),
    record("may-incident", "incident", "2026-05-01", "2026-05-31"),
  ];
  const all = [...records, ...extra];
  assert.deepEqual(
    inspectionMonths(
      all.map((r) => r.document),
      all.map((r) => r.version),
    ),
    ["2026-04", "2026-03"],
  );
  assert.deepEqual(inspectionMonths([], []), []);
});

test("inspection months include reporting intervals and issue-date fallbacks", () => {
  const all = [
    record("spanning", "inspection", "2026-12-15", "2027-02-01", {
      status: "partial",
    }),
    record("undated-period", "inspection", null, null, {
      issued_on: "2026-10-15",
    }),
    record("undated", "inspection", null),
  ];
  assert.deepEqual(
    inspectionMonths(
      all.map((r) => r.document),
      all.map((r) => r.version),
    ),
    ["2027-02", "2027-01", "2026-12", "2026-10"],
  );
});

test("April selects its records plus March findings, CAP and SOP", () => {
  assert.deepEqual(
    select(records, "2026-04"),
    records.map((r) => r.version.id).sort(),
  );
});

test("new April closure evidence is included immediately when document data refreshes", () => {
  const closure = record("closure", "inspection", "2026-04-28");
  assert.ok(select([...records, closure], "2026-04").includes("closure-v1"));
  assert.ok(!select([...records, closure], "2026-03").includes("closure-v1"));
});
test("March excludes April records and future procedures", () => {
  const future = record("future", "sop", null, null, {
    issued_on: "2026-05-01",
  });
  assert.deepEqual(select([...records, future], "2026-03"), [
    "cap-v1",
    "march-v1",
    "sop-v1",
  ]);
});
test("month relevance is evaluated before choosing a document revision", () => {
  const old = record("inspection", "inspection", "2026-03-01", "2026-03-31");
  const newer = record("inspection", "inspection", "2026-04-01", "2026-04-30", {
    id: "inspection-v2",
    revision: 2,
  });
  assert.deepEqual(select([old, newer], "2026-03"), ["inspection-v1"]);
  assert.deepEqual(select([old, newer], "2026-04"), ["inspection-v2"]);
});
test("failed and pending revisions cannot replace readable evidence", () => {
  const pending = record("april", "inspection", "2026-04-01", "2026-04-30", {
    id: "pending",
    revision: 2,
    status: "queued",
  });
  const partial = record("drill", "drill", "2026-04-15", "2026-04-15", {
    status: "partial",
  });
  const ids = select([...records, pending, partial], "2026-04");
  assert.ok(ids.includes("april-v1") && ids.includes("drill-v1"));
  assert.ok(!ids.includes("pending"));
});
test("reporting period takes precedence over a later publication date", () => {
  const late = record("late", "incident", "2026-04-01", "2026-04-30", {
    issued_on: "2026-05-02",
  });
  assert.deepEqual(select([late], "2026-04"), ["late-v1"]);
});
test("overlapping periods, year boundaries and the closest prior inspection", () => {
  const jan = record("jan", "inspection", "2027-01-01", "2027-01-31");
  const dec = record("dec", "inspection", "2026-12-01", "2026-12-31");
  const nov = record("nov", "inspection", "2026-11-01", "2026-11-30");
  const spanning = record("spanning", "drill", "2026-12-15", "2027-01-15");
  assert.deepEqual(select([jan, dec, nov, spanning], "2027-01"), [
    "dec-v1",
    "jan-v1",
    "spanning-v1",
  ]);
  assert.deepEqual(select(records, "invalid"), []);
});

test("scheduled inspection includes its CAP even when the factory issues it next month", () => {
  const report = record("report", "inspection", "2026-09-24", "2026-09-24");
  const laterCap = record("response", "cap", null, null, {
    issued_on: "2026-10-06",
  });
  const documents = [report.document, laterCap.document];
  const versions = [report.version, laterCap.version];
  assert.deepEqual(
    documentsForMonth(documents, versions, "2026-09", "2026-09-24").sort(),
    ["report-v1", "response-v1"],
  );
});

test("a September follow-up offers all twelve months and defaults to its direct predecessor's records", () => {
  const files = [
    record("july", "inspection", "2026-07-15", "2026-07-15", { case_id: "july" }),
    record("august", "inspection", "2026-08-18", "2026-08-18", { case_id: "august" }),
    record("august-cap", "cap", null, null, { case_id: "august", issued_on: "2026-09-02" }),
  ];
  const dossier = {
    case: { inspection_on: "2026-09-08", follow_up_of: "august" },
    documents: files.map(({ document }) => document),
    versions: files.map(({ version }) => version),
    prior_case_ids: ["july", "august"],
  };
  assert.deepEqual(verificationMonthOptions(dossier), Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`));
  assert.deepEqual(verificationSelection(dossier, "2026-09"), ["august-v1", "august-cap-v1"]);
  assert.deepEqual(verificationSelection(dossier, "2026-10"), []);
  assert.deepEqual(verificationSelection(dossier, "2026-07"), ["july-v1"]);
});
