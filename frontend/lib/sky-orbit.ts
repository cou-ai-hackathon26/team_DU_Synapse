export const SKY_TRANSITION_SECONDS = 1.5;

export function nextSkyPhase(phase: number, dark: boolean): number {
  const turn = Math.PI * 2;
  let target = Math.floor(phase / turn) * turn + (dark ? Math.PI : 0);
  if (target <= phase + 1e-6) target += turn;
  return target;
}

export function skyEase(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * (3 - 2 * t);
}

// Increasing phase moves right from the zenith: clockwise in screen coordinates.
// Clip/fade at the sky horizon before a body reaches the factory or information card.
export function skyPosition(phase: number) {
  const x = -.68 + Math.sin(phase) * .22;
  const y = -1.15 + Math.cos(phase) * 1.77;
  return { x, y, opacity: skyEase((y - .08) / .18) };
}
