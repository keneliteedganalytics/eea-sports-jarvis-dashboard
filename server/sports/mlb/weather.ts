// Park factors + weather/wind adjustments — SPEC §8 canonical tri-code table.
// PARK_FACTORS keyed by team tri-code is the single source of truth.

export const PARK_FACTORS: Record<string, number> = {
  COL: 1.18, CIN: 1.08, TEX: 1.07, BOS: 1.05, PHI: 1.04, ARI: 1.05,
  KC: 1.03, NYY: 1.03, CWS: 1.04, ATL: 1.02, TOR: 1.01, CHC: 1.01, BAL: 1.01,
  HOU: 1.0, LAA: 0.99, MIN: 0.99, WSH: 0.99, MIL: 0.99,
  STL: 0.97, DET: 0.97, MIA: 0.97, LAD: 0.96, CLE: 0.96, NYM: 0.96,
  SD: 0.95, TB: 0.95, PIT: 0.95, SF: 0.94, OAK: 0.93, SEA: 0.93,
};

export const PARK_FACTOR_LO = 0.85;
export const PARK_FACTOR_HI = 1.2;

export function parkFactorForTeam(triCode: string | null | undefined): number {
  if (!triCode) return 1.0;
  const f = PARK_FACTORS[triCode.toUpperCase()] ?? 1.0;
  return clamp(f, PARK_FACTOR_LO, PARK_FACTOR_HI);
}

export interface WeatherRefined {
  tempF?: number | null;
  humidity?: number | null;
  windMph?: number | null;
  // run adjustment if precomputed by an adapter
  runAdj?: number | null;
}

// Coarse weather run adjustment. Hot/dry air carries the ball → more runs.
export function weatherRunAdjust(w: WeatherRefined | null | undefined): number {
  if (!w) return 0.0;
  if (w.runAdj !== null && w.runAdj !== undefined) return w.runAdj;
  let adj = 0.0;
  if (w.tempF !== null && w.tempF !== undefined) {
    adj += (w.tempF - 70.0) * 0.006; // ~0.06 runs per 10°F above 70
  }
  if (w.windMph !== null && w.windMph !== undefined) {
    adj += Math.min(0.2, Math.max(-0.2, (w.windMph - 8.0) * 0.01));
  }
  return clamp(adj, -0.5, 0.5);
}

// Wind bearing relative to the park; out-to-CF boosts runs. Stubbed neutral
// unless an adapter supplies a precomputed bearing adjustment.
export function windDirectionRunAdjust(
  _homeTeam: string,
  weatherRaw: { windRunAdj?: number | null } | null | undefined,
): { runAdj: number } | null {
  if (!weatherRaw) return null;
  if (weatherRaw.windRunAdj !== null && weatherRaw.windRunAdj !== undefined) {
    return { runAdj: clamp(weatherRaw.windRunAdj, -0.5, 0.5) };
  }
  return { runAdj: 0.0 };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
