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

// ─── Fix 5: Handed park factors ────────────────────────────────────────────
//
// PARK_FACTORS_HANDED provides left/right batter splits for parks where the
// asymmetry is meaningful. Source: Baseball Savant park-factor splits and
// publicly available park-dimension data.
//
// NYY  — short porch in RF heavily favors LHB (~1.10 L vs ~0.96 R)
// BOS  — Fenway's Green Monster left field wall favors RHB (~1.08 R vs ~1.02 L)
// HOU  — Crawford Boxes in LF favors LHB slightly (~1.02 L vs ~0.98 R)
// MIN  — Target Field plays neutral/slight LHB favor (~1.01 L vs ~0.97 R)
// PHI  — Citizens Bank is roughly neutral with slight LHB favor (~1.06 L vs ~1.02 R)
// SF   — Oracle Park suppresses more for LHB, slight RHB edge (~0.93 L vs ~0.95 R)
// COL  — Coors is broadly homer-friendly; LHB marginally more (~1.20 L vs ~1.16 R)
// ARI  — Chase Field: LHB slight edge (~1.07 L vs ~1.03 R)
//
// The remaining 22 parks are symmetric at their scalar factor until hand-split
// data is researched and embedded in a future pass.
export const PARK_FACTORS_HANDED: Record<string, { L: number; R: number }> = {
  // Researched asymmetric parks
  NYY: { L: 1.10, R: 0.96 },
  BOS: { L: 1.02, R: 1.08 },
  HOU: { L: 1.02, R: 0.98 },
  MIN: { L: 1.01, R: 0.97 },
  PHI: { L: 1.06, R: 1.02 },
  SF:  { L: 0.93, R: 0.95 },
  COL: { L: 1.20, R: 1.16 },
  ARI: { L: 1.07, R: 1.03 },
  // Symmetric stubs — all other parks use their scalar value for both hands
  // until hand-split research is completed (v6.12.1 follow-up).
  CIN:  { L: PARK_FACTORS.CIN,  R: PARK_FACTORS.CIN  },
  TEX:  { L: PARK_FACTORS.TEX,  R: PARK_FACTORS.TEX  },
  KC:   { L: PARK_FACTORS.KC,   R: PARK_FACTORS.KC   },
  CWS:  { L: PARK_FACTORS.CWS,  R: PARK_FACTORS.CWS  },
  ATL:  { L: PARK_FACTORS.ATL,  R: PARK_FACTORS.ATL  },
  TOR:  { L: PARK_FACTORS.TOR,  R: PARK_FACTORS.TOR  },
  CHC:  { L: PARK_FACTORS.CHC,  R: PARK_FACTORS.CHC  },
  BAL:  { L: PARK_FACTORS.BAL,  R: PARK_FACTORS.BAL  },
  LAA:  { L: PARK_FACTORS.LAA,  R: PARK_FACTORS.LAA  },
  WSH:  { L: PARK_FACTORS.WSH,  R: PARK_FACTORS.WSH  },
  MIL:  { L: PARK_FACTORS.MIL,  R: PARK_FACTORS.MIL  },
  STL:  { L: PARK_FACTORS.STL,  R: PARK_FACTORS.STL  },
  DET:  { L: PARK_FACTORS.DET,  R: PARK_FACTORS.DET  },
  MIA:  { L: PARK_FACTORS.MIA,  R: PARK_FACTORS.MIA  },
  LAD:  { L: PARK_FACTORS.LAD,  R: PARK_FACTORS.LAD  },
  CLE:  { L: PARK_FACTORS.CLE,  R: PARK_FACTORS.CLE  },
  NYM:  { L: PARK_FACTORS.NYM,  R: PARK_FACTORS.NYM  },
  SD:   { L: PARK_FACTORS.SD,   R: PARK_FACTORS.SD   },
  TB:   { L: PARK_FACTORS.TB,   R: PARK_FACTORS.TB   },
  PIT:  { L: PARK_FACTORS.PIT,  R: PARK_FACTORS.PIT  },
  OAK:  { L: PARK_FACTORS.OAK,  R: PARK_FACTORS.OAK  },
  SEA:  { L: PARK_FACTORS.SEA,  R: PARK_FACTORS.SEA  },
};

// Return the handed park factor for a batter hand ("L" or "R").
// Falls back to the scalar parkFactorForTeam() when hand is null/unknown
// or the park has no entry in PARK_FACTORS_HANDED.
//
// NOTE: DO NOT change parkFactorForTeam() — the parallel agent will wire
// the handed version in v6.12.1. This utility is additive-only.
export function parkFactorForBatterHand(
  triCode: string | null | undefined,
  hand: "L" | "R" | null | undefined,
): number {
  if (!triCode) return 1.0;
  const key = triCode.toUpperCase();
  if (!hand) return parkFactorForTeam(triCode);
  const entry = PARK_FACTORS_HANDED[key];
  if (!entry) return parkFactorForTeam(triCode);
  return clamp(entry[hand], PARK_FACTOR_LO, PARK_FACTOR_HI);
}

// ─── Fix 1: Park center-field orientations for wind bearing calculation ─────
//
// PARK_ORIENTATIONS: center-field bearing IN DEGREES from home plate,
// measured as compass bearing (0 = North, 90 = East, 180 = South, 270 = West).
// This is the direction a ball travels when hit "out to CF".
//
// Sources: Baseball Savant stadium layout data, NOAA field orientation maps,
// and publicly documented park dimensions.
//
// Parks marked "// ~uncertain" use bearing 0 as a conservative default.
// These should be updated when reliable orientation data is available.
export const PARK_ORIENTATIONS: Record<string, number> = {
  CHC: 30,   // Wrigley Field — CF roughly NNE (~30°), Lake Michigan to the NE
  COL: 0,    // Coors Field — CF roughly North (~0°)
  BOS: 45,   // Fenway Park — CF roughly NE (~45°), park aligned NE/SW
  NYY: 0,    // Yankee Stadium — CF roughly North (~0°)
  NYM: 350,  // Citi Field — CF roughly NNW (~350°)
  SF:  290,  // Oracle Park — CF roughly WNW (~290°), bay to the west
  SD:  310,  // Petco Park — CF roughly NW (~310°)
  LAD: 355,  // Dodger Stadium — CF roughly North (~355°)
  ARI: 340,  // Chase Field — CF roughly NNW (~340°)
  HOU: 15,   // Minute Maid Park — CF roughly NNE (~15°)
  ATL: 25,   // Truist Park — CF roughly NNE (~25°)
  WSH: 10,   // Nationals Park — CF roughly N (~10°)
  MIA: 0,    // loanDepot park — retractable dome; bearing 0 (indoor, minimal wind effect) // ~uncertain
  TB:  0,    // Tropicana Field — dome; bearing 0 // ~uncertain
  MIN: 350,  // Target Field — CF roughly NNW (~350°)
  TEX: 0,    // Globe Life Field — retractable roof; bearing 0 // ~uncertain
  MIL: 5,    // American Family Field — retractable; CF roughly N (~5°)
  TOR: 0,    // Rogers Centre — dome; bearing 0 // ~uncertain
  SEA: 330,  // T-Mobile Park — CF roughly NNW (~330°)
  OAK: 320,  // Oakland Coliseum — CF roughly NW (~320°)
  CLE: 5,    // Progressive Field — CF roughly N (~5°)
  DET: 15,   // Comerica Park — CF roughly NNE (~15°)
  CIN: 0,    // Great American Ball Park — CF roughly N (~0°)
  PIT: 5,    // PNC Park — CF roughly N (~5°), Allegheny River to NW
  STL: 15,   // Busch Stadium — CF roughly NNE (~15°)
  KC:  355,  // Kauffman Stadium — CF roughly N (~355°)
  BAL: 350,  // Oriole Park at Camden Yards — CF roughly NNW (~350°)
  PHI: 340,  // Citizens Bank Park — CF roughly NNW (~340°)
  CWS: 355,  // Guaranteed Rate Field — CF roughly N (~355°)
  LAA: 0,    // Angel Stadium — CF roughly N (~0°) // ~uncertain
  CHW: 355,  // alias
};

// ─── WeatherRefined ─────────────────────────────────────────────────────────

export interface WeatherRefined {
  tempF?: number | null;
  humidity?: number | null;
  windMph?: number | null;
  windBearingDeg?: number | null; // compass bearing wind is blowing TO (0=N,90=E)
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

// Wind direction run adjustment.
//
// Computes how much a given wind bearing and speed affect run scoring by
// projecting wind onto the home-plate → center-field axis.
//
// windBearingDeg: compass direction wind is blowing TO (0=N, 90=E, 180=S, 270=W).
// windMph: wind speed in miles per hour.
//
// A wind blowing directly out to CF (aligned with the park's CF bearing) boosts
// runs; a wind blowing in from CF reduces them. Crosswinds have no effect.
//
// Rate: +0.04 runs per mph of wind component along the out-to-CF axis.
// Clamped ±0.40 runs.
//
// Backward compat: if weatherRaw.windRunAdj is pre-computed by an adapter,
// it is used directly (highest priority) and the bearing calculation is skipped.
export function windDirectionRunAdjust(
  homeTeam: string,
  weatherRaw:
    | { windRunAdj?: number | null; windBearingDeg?: number | null; windMph?: number | null }
    | null
    | undefined,
): { runAdj: number } | null {
  if (!weatherRaw) return null;

  // Shortcut: adapter pre-computed the adjustment.
  if (weatherRaw.windRunAdj !== null && weatherRaw.windRunAdj !== undefined) {
    return { runAdj: clamp(weatherRaw.windRunAdj, -0.5, 0.5) };
  }

  const windBearing = weatherRaw.windBearingDeg;
  const windMph = weatherRaw.windMph;

  // Need both bearing and speed to compute a real adjustment.
  if (
    windBearing === null || windBearing === undefined ||
    windMph === null || windMph === undefined
  ) {
    return { runAdj: 0.0 };
  }

  const key = homeTeam?.toUpperCase();
  const cfBearing = PARK_ORIENTATIONS[key] ?? 0;

  // Angular delta between wind direction and the out-to-CF direction.
  // cos(0) = 1 (tailwind to CF), cos(180) = -1 (headwind from CF),
  // cos(90) = 0 (crosswind).
  const deltaRad = ((windBearing - cfBearing) * Math.PI) / 180;
  const component = Math.cos(deltaRad); // [-1, 1]

  // +0.04 runs per mph component along the out-to-CF axis.
  const adj = component * windMph * 0.04;

  return { runAdj: clamp(adj, -0.40, 0.40) };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
