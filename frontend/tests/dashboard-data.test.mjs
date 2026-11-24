import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
function load(path) {
  const module = { exports: {} };
  const code = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: () => load("../lib/evidence-intelligence.ts") });
  return module.exports;
}
const { loadDashboardData, dashboardDistribution, dashboardMetrics, caseDocuments } = load("../lib/dashboard-data.ts");
const run = (id, date, status = "complete") => ({ id, created_at: date, status, manifest: [], usage: {} });
const dossier = (id, role, runs = []) => ({ case: { id, inspection_on: "2026-11-24" }, role, runs, documents: [{ id: "doc1", role: "inspection" }, { id: "doc2", role: "cap" }] });

test("reviewer charts include needs-review and not-assessed data rather than zero-only categories", () => {
  const data = { dossier: dossier("a", "reviewer"), board: null, results: [{ outcome: "needs_review" }, { outcome: "not_assessed" }, { outcome: "supported" }] };
  const chart = dashboardDistribution(data);
  assert.equal(chart.unit, "statements");
  assert.equal(chart.values.reduce((sum, row) => sum + row.value, 0), 3);
  assert.equal(chart.values.find((row) => row.label === "Needs review").value, 1);
});

test("manager charts use actual authorized corrective tasks and never invent AI findings", async () => {
  const calls = [];
  const data = await loadDashboardData(dossier("manager-case", "manager"), async (path) => {
    calls.push(path); return { tasks: [{ id: "t1", status: "assigned" }, { id: "t2", status: "in_progress" }], events: [] };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "/v1/cases/manager-case/corrective-work");
  assert.equal(dashboardMetrics(data, false)[1].value, 2);
  assert.equal(dashboardDistribution(data).unit, "documents");
  assert.equal(data.results.length, 0);
});

test("history reads dated authorized runs, selects the newest readable run and changes cases cleanly", async () => {
  const first = dossier("a", "reviewer", [run("old", "2026-11-21"), run("new", "2026-11-24"), run("failed", "2026-11-25", "failed")]);
  const calls = [];
  const data = await loadDashboardData(first, async (path) => {
    calls.push(path);
    return path.endsWith("corrective-work") ? { tasks: [], events: [] } : [{ id: path, outcome: "supported" }];
  });
  assert.equal(data.results[0].id, "/v1/runs/new/results");
  assert.equal(data.history.length, 2);
  assert.ok(!calls.some((path) => path.includes("failed")));
  const second = await loadDashboardData(dossier("b", "reviewer"), async () => ({ tasks: [], events: [] }));
  assert.equal(second.results.length, 0);
  assert.equal(second.history.length, 0);
  assert.equal(second.dossier.case.id, "b");
});

test("one unavailable metric preserves other authorized documents, work and history", async () => {
  const data = await loadDashboardData(dossier("a", "reviewer", [run("new", "2026-11-24")]), async (path) => {
    if (path.endsWith("results")) throw new Error("denied");
    return { tasks: [], events: [] };
  });
  assert.ok(data.resultsError);
  assert.equal(data.history[0].results, null);
  assert.equal(dashboardDistribution(data).unit, "documents");
  assert.equal(dashboardDistribution(data).values.reduce((sum, row) => sum + row.value, 0), 2);
});

test("case/user switches mask stale snapshots immediately and abort earlier requests", () => {
  const hook = read("../components/v2/use-evidence-intelligence.ts");
  assert.match(hook, /snapshot.key === key/);
  assert.match(hook, /caseData.owner === owner/);
  assert.match(hook, /controller.abort\(\)/);
  assert.match(hook, /if \(!controller.signal.aborted\) setSnapshot/);
});

test("loading, denied requests, restricted documents and actual empty responses are distinct", async () => {
  assert.ok(dashboardMetrics(null, true).every((m) => m.display === "Loading…" && m.value === null));
  const denied = await loadDashboardData(dossier("a", "reviewer"), async () => { throw new Error("403: forbidden"); });
  assert.equal(dashboardMetrics(denied, false)[1].display, "Unavailable");
  assert.match(dashboardMetrics(denied, false)[1].message, /403/);
  const empty = dossier("a", "reviewer"); empty.documents = [];
  const data = await loadDashboardData(empty, async () => ({ tasks: [], events: [] }));
  assert.ok(dashboardMetrics(data, false).every((m) => m.display === 0));
  const restricted = dossier("a", "manager"); restricted.case.inspection_on = null;
  assert.equal(caseDocuments(restricted), null);
});

test("selected-case counts exclude prior-case documents, duplicates and cross-case task events", async () => {
  const input = dossier("a", "reviewer");
  input.documents.push({ id: "prior", role: "inspection", case_id: "previous" }, { id: "doc1", role: "inspection" });
  const data = await loadDashboardData(input, async () => ({
    tasks: [{ id: "t1", status: "assigned", case_id: "a" }, { id: "t2", case_id: "other" }],
    events: [{ id: "e1", case_id: "a" }, { id: "e2", case_id: "a" }, { id: "e3", case_id: "other" }],
  }));
  assert.equal(dashboardMetrics(data, false).map((m) => m.value).join(","), "2,1,2");
  assert.equal(dashboardDistribution(data).values.reduce((s, v) => s + v.value, 0), 2);
});
