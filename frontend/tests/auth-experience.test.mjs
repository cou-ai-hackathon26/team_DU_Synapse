import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const login = read("../components/v2/login-screen.tsx");
const onboarding = read("../components/onboarding.tsx");
const reviewerRoute = read("../app/signup/reviewer/page.tsx");
const css = read("../app/v2.css");

test("login and reviewer request reuse the shared V2 authentication shell", () => {
  assert.match(login, /<AuthShell/);
  assert.match(onboarding, /function RequestReviewerAccess\(\)[\s\S]*?<AuthShell/);
  assert.match(reviewerRoute, /<RequestReviewerAccess \/>/);
});

test("reviewer request keeps its existing fields and backend workflow", () => {
  assert.match(onboarding, /api\("\/v1\/signup\/reviewer"/);
  assert.match(onboarding, /reviewerDetails\(form\)/);
  assert.match(onboarding, /<ReviewerFields \/>/);
  assert.match(onboarding, /Send access request/);
});

test("auth glass remains theme-aware and fields retain opaque contrast", () => {
  assert.match(css, /\.login-glass-panel \{[^}]*background: rgba\(245,249,248,\.6\)/s);
  assert.match(css, /:root\[data-theme="dark"\] \.login-glass-panel \{[^}]*background: rgba\(10,24,30,\.56\)/s);
  assert.match(css, /\.v2-access-form input:not\(\[type="hidden"\]\), \.v2-access-form select \{[^}]*var\(--sp-surface\)/s);
});
