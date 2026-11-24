import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../components/v2/scroll-reveal.tsx", import.meta.url),
  "utf8",
);
const home = readFileSync(
  new URL("../components/v2/public-home.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../app/v2.css", import.meta.url), "utf8");

test("home sections alternate reveal direction with a shared observer", () => {
  assert.match(component, /let sharedObserver: IntersectionObserver \| null = null/);
  assert.match(home, /id="about"[^>]*direction="left"/);
  assert.match(home, /id="how-it-works"[^>]*direction="right"/);
  assert.match(home, /id="features"[^>]*direction="left"/);
  assert.match(home, /id="roles"[^>]*direction="right"/);
});

test("reveals respect reduced motion and keep a no-script fallback", () => {
  assert.match(component, /prefers-reduced-motion: reduce/);
  assert.match(home, /<noscript>/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*\.scroll-reveal/s);
});

test("reveals use deliberate timing and hero panels enter from opposite sides", () => {
  assert.match(css, /\.scroll-reveal \{[^}]*1\.6s cubic-bezier/s);
  assert.match(css, /nth-child\(2\) \{ transition-delay: 220ms;/);
  assert.match(home, /industrial-status-panel hero-panel-enter hero-panel-enter-left/);
  assert.match(home, /industrial-hero-panel hero-panel-enter hero-panel-enter-right/);
  assert.match(css, /\.auth-panel-enter \{[^}]*1\.6s/s);
});
