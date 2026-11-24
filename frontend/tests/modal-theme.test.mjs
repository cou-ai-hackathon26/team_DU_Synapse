import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../app/modal-theme.css");
const v2 = read("../app/v2.css");

function luminance(hex) {
  const rgb = hex.match(/[\da-f]{2}/gi).map((x) => parseInt(x, 16) / 255)
    .map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

test("dialogs own their theme tokens, including outside the workspace", () => {
  const dialog = css.match(/dialog\.modal \{([^}]+)\}/s)[1];
  for (const token of ["ink", "muted", "line", "white", "shadow"]) assert.match(dialog, new RegExp(`--${token}: var\\(--sp-`));
  assert.match(dialog, /background: var\(--sp-surface\)/);
  assert.match(dialog, /color: var\(--sp-text\)/);
  assert.match(css, /data-theme="dark"[\s\S]*color-scheme: dark/);
  assert.match(read("../components/ui.tsx"), /import "@\/app\/modal-theme.css"/);
});

test("text and muted descriptions meet AA on dialog and shared panel surfaces in both themes", () => {
  for (const selector of [":root", ':root[data-theme="dark"]']) {
    const block = v2.slice(v2.indexOf(selector + " {"));
    const tokens = Object.fromEntries([...block.slice(0, block.indexOf("}")).matchAll(/--sp-([\w-]+): (#[\da-f]{6});/g)].map((m) => [m[1], m[2]]));
    for (const foreground of ["text", "muted"]) {
      for (const surface of ["surface", "surface-soft"]) assert.ok(contrast(tokens[foreground], tokens[surface]) >= 4.5, `${selector}: ${foreground}/${surface}`);
    }
  }
});

test("dialog fields, close/action buttons, popups and intentional status panels retain paired colors", () => {
  assert.match(css, /input:not\(\[type="checkbox"\]\), select, textarea/);
  assert.match(css, /input\[readonly\].*var\(--sp-surface-soft\)/);
  assert.match(css, /button\.primary.*background: #224c3e; color: #fff/);
  assert.match(css, /button\.danger.*background: #a33135; color: #fff/);
  assert.match(css, /\.icon-button\)/);
  assert.match(css, /\.account-popover.*\.notification-popover.*\.panel/);
  for (const [fg, bg] of [["275842", "e8f3e9"], ["7a531b", "fff1d8"], ["8a3639", "fcebea"], ["ffffff", "a33135"]]) assert.ok(contrast(fg, bg) >= 4.5);
  assert.doesNotMatch(css, /!important/);
});
