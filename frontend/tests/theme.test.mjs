import assert from "node:assert/strict";
import test from "node:test";
import { oppositeTheme, serverTheme, validTheme } from "../lib/theme.ts";

test("theme state starts with the same deterministic server value", () => {
  assert.equal(serverTheme, "light");
  assert.equal(validTheme(undefined), serverTheme);
  assert.equal(validTheme("unexpected"), serverTheme);
});

test("persisted dark mode and theme toggling remain supported", () => {
  assert.equal(validTheme("dark"), "dark");
  assert.equal(oppositeTheme("dark"), "light");
  assert.equal(oppositeTheme("light"), "dark");
});
