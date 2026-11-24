import assert from "node:assert/strict";
import test from "node:test";
import {
  activeShellKey,
  shellNavigation,
  shellTitle,
} from "../lib/app-navigation.ts";

test("admin navigation exposes every existing management workflow", () => {
  assert.deepEqual(
    shellNavigation("admin").map(({ key }) => key),
    ["dashboard", "factories", "reviewers", "assignments", "inspections", "applications"],
  );
});

test("reviewer navigation preserves the selected case and run", () => {
  const links = shellNavigation("reviewer", "case 7", "run 2");
  assert.equal(links.find(({ key }) => key === "documents")?.href, "/workspace?case=case+7&view=documents");
  assert.equal(links.find(({ key }) => key === "review")?.href, "/workspace?case=case+7&view=review&run=run+2");
});

test("manager navigation uses only manager-authorized workflow links", () => {
  assert.deepEqual(
    shellNavigation("factory_manager", "case-1").map(({ key }) => key),
    ["dashboard", "cases", "documents", "corrective"],
  );
});

test("workspace views select the matching persistent shell destination", () => {
  assert.equal(activeShellKey("/dashboard", null), "dashboard");
  assert.equal(activeShellKey("/workspace", "scheduled-inspections"), "inspections");
  assert.equal(activeShellKey("/workspace", "cap"), "review");
  assert.equal(shellTitle("/workspace", "manager-applications"), "Manager applications");
});
