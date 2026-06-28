// v6.13.0 — Hatfield-style Statcast + Spot Rules (pure functions).
//
// Every function here is purely additive and regression-safe: when its inputs
// are null/absent it returns a no-op (zero adjustment, flag false — except
// lineupHealthy, whose healthy=true default is itself the no-op). The model and
// picks engine apply these on top of the existing pipeline, so a slate with the
// Statcast feed unavailable AND no spot/price flags firing reproduces prior
// output exactly. See HATFIELD_RULES_SPEC.md for the methodology.

// League-average anchors (Rule 2). A missing Statcast field falls back to its
// league average, which contributes 0 to the composite — that is how an absent
// feed degrades to score=50 / neutral / 0 runs.
export const LG_AVG_XBA = 0.24;
export const LG_AVG_BARREL_PCT = 7.0;
export const LG_AVG_SWEETSPOT_PCT = 33.3;

// Per-SP Statcast contact-quality + control inputs (Rule 1/2/3). All nullable;
// null fields fall back to league average (Rule 2) or no-op (Rule 1/3).
export interface StarterStatcast {
  era: number | null;
  xera: number | null;
  xbaAllowed: number | null;
  barrelRatePct: number | null;
  sweetSpotPct: number | null;
  bbPct: number | null;
}

// Rule 4 series state. Null/undefined → spot never fires.
export interface SeriesContext {
  sameDivision: boolean;
  seriesLength: number;          // 3 or 4
  gameNumberInSeries: number;    // 1-based
  trailingTeamLostFirstTwo: boolean;
  trailingTeamPositiveRunDiff: boolean;
  trailingSide: "home" | "away" | null; // which side gets the winProb nudge
}

// Rule 6 telemetry input — a team's last-18 ML record split by venue.
export interface Last18Record {
  awayWinPct: number | null;
  homeWinPct: number | null;
}

export type ContactBand = "elite" | "neutral" | "weak";

export interface SpotProfile {
  fadeFlag: boolean;             // Rule 1
  eraXeraGap: number | null;     // Rule 1
  contactQualityScore: number;   // Rule 2 (50 = neutral when no data)
  xBAAllowed: number | null;     // Rule 2 raw
  barrelRatePct: number | null;  // Rule 2 raw
  launchAngleSweetSpotPct: number | null; // Rule 2 raw
  baseTrafficOverTilt: boolean;  // Rule 3
  sweepAvoidanceSpot: boolean;   // Rule 4
  priceCap: { side: boolean; total: boolean }; // Rule 5
  trendConfirm: boolean;         // Rule 6
  lineupHealthy: boolean;        // Rule 7
}

function isNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

// ── Rule 1: ERA vs xERA mean-reversion fade ──────────────────────────────
// gap = actualERA - xERA. gap <= -1.00 (ERA a full run below xERA) → the SP is
// overperforming; flag as a fade candidate and add +0.20 runs/9 to the
// opponent's projection. Missing era/xera → no-op.
export function computeFadeFlag(
  era: number | null | undefined,
  xera: number | null | undefined,
): { fadeFlag: boolean; runsAdj: number; eraXeraGap: number | null } {
  if (!isNum(era) || !isNum(xera)) return { fadeFlag: false, runsAdj: 0, eraXeraGap: null };
  const eraXeraGap = era - xera;
  const fadeFlag = eraXeraGap <= -1.0;
  return { fadeFlag, runsAdj: fadeFlag ? 0.2 : 0, eraXeraGap };
}

// ── Rule 2: Statcast contact-quality composite ───────────────────────────
// score = 50 + 200*(xBA-.240) + 10*(barrel-7.0) + 2.5*(sweetSpot-33.3). Lower is
// better (elite suppressor). <35 elite → -0.15 runs/9; 35..65 neutral → 0;
// >65 weak → +0.15 runs/9. Each missing field falls back to league average, so
// an entirely-absent feed yields exactly 50 / neutral / 0.
export function computeContactQualityScore(
  xbaAllowed: number | null | undefined,
  barrelRatePct: number | null | undefined,
  sweetSpotPct: number | null | undefined,
): { score: number; runsAdj: number; band: ContactBand } {
  const xba = isNum(xbaAllowed) ? xbaAllowed : LG_AVG_XBA;
  const barrel = isNum(barrelRatePct) ? barrelRatePct : LG_AVG_BARREL_PCT;
  const sweet = isNum(sweetSpotPct) ? sweetSpotPct : LG_AVG_SWEETSPOT_PCT;
  const score =
    50 +
    200 * (xba - LG_AVG_XBA) +
    10 * (barrel - LG_AVG_BARREL_PCT) +
    2.5 * (sweet - LG_AVG_SWEETSPOT_PCT);
  let band: ContactBand = "neutral";
  let runsAdj = 0;
  if (score < 35) {
    band = "elite";
    runsAdj = -0.15;
  } else if (score > 65) {
    band = "weak";
    runsAdj = 0.15;
  }
  return { score, runsAdj, band };
}

// ── Rule 3: walk-rate base-traffic Over tilt ─────────────────────────────
// Either SP bbPct >= 10.0 → runsEnv += 0.25 and flag the tilt; both >= 10.0 →
// runsEnv += 0.50. Missing bbPct counts as below threshold (no-op).
export function computeBaseTrafficTilt(
  homeBbPct: number | null | undefined,
  awayBbPct: number | null | undefined,
): { tilt: boolean; runsEnvAdj: number } {
  const homeHi = isNum(homeBbPct) && homeBbPct >= 10.0;
  const awayHi = isNum(awayBbPct) && awayBbPct >= 10.0;
  if (homeHi && awayHi) return { tilt: true, runsEnvAdj: 0.5 };
  if (homeHi || awayHi) return { tilt: true, runsEnvAdj: 0.25 };
  return { tilt: false, runsEnvAdj: 0 };
}

// ── Rule 4: division-rival sweep-avoidance overlay ───────────────────────
// All must hold: same division; game 3+ of a 3-or-4-game series; trailing team
// lost the first two; trailing team has a positive YTD run differential. Fires
// +0.025 winProb for the trailing side (a thumb on the scale). Null → no-op.
export function computeSweepSpot(
  ctx: SeriesContext | null | undefined,
): { sweepAvoidanceSpot: boolean; winProbAdj: number; side: "home" | "away" | null } {
  if (!ctx) return { sweepAvoidanceSpot: false, winProbAdj: 0, side: null };
  const fires =
    ctx.sameDivision === true &&
    (ctx.seriesLength === 3 || ctx.seriesLength === 4) &&
    ctx.gameNumberInSeries >= 3 &&
    ctx.trailingTeamLostFirstTwo === true &&
    ctx.trailingTeamPositiveRunDiff === true &&
    (ctx.trailingSide === "home" || ctx.trailingSide === "away");
  if (!fires) return { sweepAvoidanceSpot: false, winProbAdj: 0, side: null };
  return { sweepAvoidanceSpot: true, winProbAdj: 0.025, side: ctx.trailingSide };
}

// ── Rule 5: price-cap discipline (hard auto-lock gate) ───────────────────
// side cap: a side/ML price shorter than -130 (strictly more negative) when the
//   tier is NOT SNIPER — above -130 the price erodes edge faster than the model
//   can compensate. SNIPER keeps its own -250 cap (handled elsewhere).
// total cap: an Over total >= 8.5 whose opener was 7.5 or 8 — the line moved
//   through the playable window. Missing inputs → false.
export function computePriceCap(
  tier: string | null | undefined,
  sidePrice: number | null | undefined,
  totalNumber: number | null | undefined,
  totalOpener: number | null | undefined,
): { side: boolean; total: boolean } {
  const side =
    tier !== "SNIPER" && isNum(sidePrice) && sidePrice < -130;
  const total =
    isNum(totalNumber) &&
    totalNumber >= 8.5 &&
    isNum(totalOpener) &&
    (totalOpener === 7.5 || totalOpener === 8);
  return { side, total };
}

// ── Rule 6: recent away/home ML trend (telemetry only, non-gating) ───────
// last18AwayWinPct >= 0.60 AND the pick is the away side → trendConfirm. No
// winProb change in v6.13. Null record → false.
export function computeTrendConfirm(
  isAwayPick: boolean,
  last18: Last18Record | null | undefined,
): { trendConfirm: boolean } {
  if (!isAwayPick || !last18 || !isNum(last18.awayWinPct)) return { trendConfirm: false };
  return { trendConfirm: last18.awayWinPct >= 0.6 };
}

// ── Rule 7: lineup-health flag (surface only) ────────────────────────────
// lineupHealthy = injuryWOBAOut < 0.020. Absent injury data → 0 → healthy
// (the no-op default).
export function computeLineupHealth(
  injuryWOBAOut: number | null | undefined,
): { lineupHealthy: boolean } {
  const out = isNum(injuryWOBAOut) ? injuryWOBAOut : 0;
  return { lineupHealthy: out < 0.02 };
}

// ── Rule 8: composite spot summary ───────────────────────────────────────
export function assembleSpotProfile(parts: {
  fade: { fadeFlag: boolean; eraXeraGap: number | null };
  contact: { score: number };
  statcast: StarterStatcast | null;
  baseTraffic: { tilt: boolean };
  sweep: { sweepAvoidanceSpot: boolean };
  priceCap: { side: boolean; total: boolean };
  trend: { trendConfirm: boolean };
  lineup: { lineupHealthy: boolean };
}): SpotProfile {
  return {
    fadeFlag: parts.fade.fadeFlag,
    eraXeraGap: parts.fade.eraXeraGap,
    contactQualityScore: parts.contact.score,
    xBAAllowed: parts.statcast?.xbaAllowed ?? null,
    barrelRatePct: parts.statcast?.barrelRatePct ?? null,
    launchAngleSweetSpotPct: parts.statcast?.sweetSpotPct ?? null,
    baseTrafficOverTilt: parts.baseTraffic.tilt,
    sweepAvoidanceSpot: parts.sweep.sweepAvoidanceSpot,
    priceCap: parts.priceCap,
    trendConfirm: parts.trend.trendConfirm,
    lineupHealthy: parts.lineup.lineupHealthy,
  };
}

// Cap applied to the cumulative spot-overlay winProb adjustment (Rule 4 today,
// room for more). Spots can never override the model.
export const MAX_SPOT_WINPROB_ADJ = 0.05;
