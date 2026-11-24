import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadDashboardScope, selectDashboardScope } from "../lib/dashboard-scope.ts";

const reviewer = { id: "reviewer", role: "reviewer", factory_id: null };
const factoryA = { id: "a", name: "Factory A" }, factoryB = { id: "b", name: "Factory B" };
const cases = [{ id: "ca", factory: factoryA.name }, { id: "cb", factory: factoryB.name }, { id: "other", factory: "Unassigned" }];

test("reviewer options come from assignments, including factories without cases", async () => {
  const calls = [];
  const scope = await loadDashboardScope(reviewer, async (path) => {
    calls.push(path);
    return path === "/v1/cases" ? [cases[0], cases[2]] : [{ factories: factoryA }, { factories: factoryB }];
  });
  assert.deepEqual(scope.factories, [factoryA, factoryB]);
  assert.deepEqual(scope.cases.map((c) => c.id), ["ca"]);
  assert.equal(selectDashboardScope(scope, "b", "ca").cases.length, 0);
  assert.ok(calls.includes("/v1/reviewer/factories"));
  assert.ok(!calls.includes("/v1/factories"));
});

test("factory switching resets invalid cases and never retains another factory's data", () => {
  const scope = { factories: [factoryA, factoryB], cases: cases.slice(0, 2) };
  const selected = selectDashboardScope(scope, "b", "ca");
  assert.equal(selected.selectedCase.id, "cb");
  assert.deepEqual(selected.cases.map((c) => c.id), ["cb"]);
  assert.equal(selectDashboardScope(scope, "forged-storage-id", "other").factory.id, "a");
  assert.equal(selectDashboardScope({ factories: [], cases }, "a", "ca").selectedCase, undefined);
});

test("manager uses only the authenticated bound factory and rejects mismatches", async () => {
  const manager = { id: "manager", role: "factory_manager", factory_id: "a" };
  const scope = await loadDashboardScope(manager, async (path) => path === "/v1/cases" ? cases : { factory: factoryA });
  assert.deepEqual(scope.factories, [factoryA]);
  assert.deepEqual(scope.cases.map((c) => c.id), ["ca"]);
  await assert.rejects(loadDashboardScope(manager, async (path) => path === "/v1/cases" ? cases : { factory: factoryB }), /could not be verified/);
});

test("assignment API failures never fall back to public or cached factory lists", async () => {
  await assert.rejects(loadDashboardScope(reviewer, async (path) => {
    if (path !== "/v1/cases") throw new Error("403 assignment read denied");
    return cases;
  }), /403/);
});

test("role changes and manager reassignment are part of the snapshot and storage scope", () => {
  const hook = readFileSync(new URL("../components/v2/use-evidence-intelligence.ts", import.meta.url), "utf8");
  assert.match(hook, /auth.profile.id.*auth.profile.role.*auth.profile.factory_id/);
  assert.match(hook, /\$\{owner\}:\$\{selectedFactoryId\}:\$\{selectedCaseId\}/);
  assert.match(hook, /safetyproof-dashboard-factory:\$\{owner\}/);
  assert.match(hook, /factoryId, caseId: ""/);
  assert.match(hook, /dossier.case.id !== selectedCaseId/);
});
