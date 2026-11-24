import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nextSkyPhase, skyEase, skyPosition, SKY_TRANSITION_SECONDS } from "../lib/sky-orbit.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("day and night place the correct body in upper-left sky with the other below the horizon", () => {
  for (const phase of [0, Math.PI, Math.PI * 2]) {
    const visible = skyPosition(phase + (phase === Math.PI ? Math.PI : 0));
    assert.ok(visible.x < -.6 && visible.y > .6 && visible.opacity === 1);
    assert.equal(skyPosition(phase + (phase === Math.PI ? 0 : Math.PI)).opacity, 0);
  }
});

test("both theme transitions increase orbital phase and move clockwise from the zenith", () => {
  assert.equal(nextSkyPhase(0, true), Math.PI);
  assert.equal(nextSkyPhase(Math.PI, false), Math.PI * 2);
  const start = skyPosition(0);
  const next = skyPosition(.15);
  assert.ok(next.x > start.x && next.y < start.y);
  assert.equal(SKY_TRANSITION_SECONDS, 1.5);
  assert.equal(skyEase(0), 0);
  assert.equal(skyEase(1), 1);
  assert.equal(skyEase(.5), .5);
});

test("rapid theme changes retarget forward from the current position to the correct body", () => {
  let phase = .4;
  for (const dark of [false, true, false, true]) {
    const target = nextSkyPhase(phase, dark);
    assert.ok(target > phase && target - phase <= Math.PI * 2);
    assert.ok(Math.abs(Math.cos(target) - (dark ? -1 : 1)) < 1e-10);
    phase += (target - phase) * .15;
  }
});

test("celestial geometry is Home-only, retains the original toggle and does not remount Home canvas", () => {
  const home = read("../components/v2/public-home.tsx");
  const factory = read("../components/v2/animated-garment-factory.tsx");
  assert.doesNotMatch(home, /HomeThemeControl|public-brand-controls/);
  assert.equal((home.match(/<ThemeToggle \/>/g) || []).length, 1);
  assert.match(home, /<AnimatedGarmentFactory celestialSky \/>/);
  assert.match(read("../components/v2/auth-shell.tsx"), /<AnimatedGarmentFactory compact \/>/);
  assert.match(factory, /celestialSky = false/);
  assert.match(factory, /key=\{celestialSky \? "home-factory" : theme\}/);
  assert.match(factory, /<FactoryErrorBoundary>/);
  assert.match(factory, /fallback=\{/);
});

test("saved preference initialization and reduced motion select a static sky; resize uses camera aspect", () => {
  const sky = read("../components/v2/factory-sky.tsx");
  assert.match(sky, /useTheme\(\)/);
  assert.match(sky, /!state.initialized \|\| reducedMotion/);
  assert.match(sky, /state.phase = state.target = dark \? Math.PI : 0/);
  assert.match(sky, /perspective.aspect/);
  assert.doesNotMatch(sky, /setTheme|localStorage|setInterval|setTimeout/);
  assert.match(sky, /state.start = state.phase/);
  assert.match(sky, /skyPosition\(state.phase \+ index \* Math.PI\)/);
});
