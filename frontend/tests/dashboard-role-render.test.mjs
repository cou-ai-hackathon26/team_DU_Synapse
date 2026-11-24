import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
function render(role, state = "ready", denied = false) {
  const dossier = { case: { id: "c1", factory: "Assigned factory", inspection_on: "2026-11-24" }, role: role === "factory_manager" ? "manager" : "reviewer", documents: [{ id: "d1", role: "inspection" }], runs: [] };
  const data = state === "loading" ? null : { dossier, documents: dossier.documents, documentError: "", results: [], resultsError: "", board: denied ? null : { tasks: [{ id: "t1", title: "Task", status: "assigned" }], events: [{ id: "e1", task_id: "t1", action: "assigned", created_at: "2026-11-24" }] }, boardError: denied ? "403: selected-case work unavailable" : "", history: [] };
  const evidence = { accountState: "ready", evidenceState: state, realMode: true, error: "", factories: [{ id: "f1", name: "Assigned factory" }, ...(role === "reviewer" ? [{ id: "f2", name: "Second assigned factory" }] : [])], cases: [{ id: "c1", title: "Selected case", factory: "Assigned factory" }], selectedFactory: "Assigned factory", selectedFactoryId: "f1", selectedCaseId: "c1", dossier: data?.dossier ?? null, data, results: [], history: [], board: data?.board ?? null, boardError: data?.boardError ?? "" };
  evidence.factoryCases = evidence.cases;
  const modules = new Map();
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const module = { exports: {} }; modules.set(path, module.exports);
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require(id) {
      if (id === "next/link") return { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
      if (id === "next/navigation") return { useRouter: () => ({ replace() {} }) };
      if (id === "lucide-react") return new Proxy({}, { get: () => () => React.createElement("svg") });
      if (id === "./auth-provider") return { useAuth: () => ({ state: "authenticated", profile: { role } }) };
      if (id === "./use-evidence-intelligence") return { useEvidenceIntelligence: () => evidence };
      if (id === "@/lib/review") return { reviewStatus: () => "Pending review" };
      if (id === "@/lib/api") return { dateText: (value) => value };
      if (id === "@/lib/dashboard-data") return load("../lib/dashboard-data.ts");
      if (id === "@/lib/evidence-intelligence" || id === "./evidence-intelligence") return load("../lib/evidence-intelligence.ts");
      return require(id);
    } });
    return module.exports;
  }
  return renderToStaticMarkup(React.createElement(load("../components/v2/analytics-dashboard.tsx").AnalyticsDashboard));
}

test("rendered reviewer has assigned-factory options; rendered manager has fixed factory text", () => {
  const reviewer = render("reviewer");
  assert.match(reviewer, /aria-label="Select factory"/);
  assert.match(reviewer, /Second assigned factory/);
  const manager = render("factory_manager");
  assert.doesNotMatch(manager, /aria-label="Select factory"|Second assigned factory/);
  assert.match(manager, /dashboard-factory-value/);
  assert.match(manager, /aria-label="Select case"/);
});

test("rendered KPIs display actual selected-case counts and never turn loading/errors into zero", () => {
  const ready = render("reviewer");
  for (const label of ["Authorized documents", "Corrective tasks", "Work updates"]) assert.ok(ready.includes(`<span>${label}</span><strong>1</strong>`));
  const loading = render("reviewer", "loading");
  assert.ok(loading.includes("<span>Authorized documents</span><strong>Loading…</strong>"));
  const denied = render("reviewer", "ready", true);
  assert.ok(denied.includes("<span>Corrective tasks</span><strong>Unavailable</strong>"));
  assert.match(denied, /403: selected-case work unavailable/);
});
