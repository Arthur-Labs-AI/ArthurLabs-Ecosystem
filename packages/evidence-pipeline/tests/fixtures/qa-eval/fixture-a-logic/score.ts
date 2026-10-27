export function clampScore(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100 + 1;
  return v;
}
