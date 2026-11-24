import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/v2.css", import.meta.url), "utf8");
const dashboard = readFileSync(
  new URL("../components/v2/analytics-dashboard.tsx", import.meta.url),
  "utf8",
);

test("dashboard KPI cards reserve separate label, value, and detail rows", () => {
  assert.match(css, /\.kpi-card \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/s);
  assert.match(css, /\.kpi-card strong \{[^}]*line-height: \.95;/s);
});

test("factory and case selectors remain responsive and identify full selections", () => {
  assert.match(css, /\.dashboard-selectors \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.doesNotMatch(css, /\.dashboard-selectors \{ display: none;/);
  assert.match(dashboard, /aria-label="Select factory" title=/);
  assert.match(dashboard, /aria-label="Select case" title=/);
});

test("legacy case metrics inherit V2 light and dark theme surfaces", () => {
  assert.match(css, /\.unified-app-shell \.case-metric \{[^}]*background: var\(--sp-surface\);[^}]*color: var\(--sp-text\);/s);
});
