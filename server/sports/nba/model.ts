// NBA win-probability + points model. Possession-based: each team's points are
// projected from ORtg vs opponent DRtg at a blended pace, plus a home-court
// points edge, then converted to a win probability via a points-margin logistic
// and shrunk toward the market at MODEL_TRUST_WEIGHT (mirrors MLB/NHL).

import { probToAmerican } from "../../core/odds";

export const NBA_LG_ORTG = 114.0; // league offensive rating (pts / 100 poss)
export const NBA_LG_PACE = 99.5; // league possessions per 48
export const NBA_HOME_PTS = 2.5; // home-court points advantage
export const MARGIN_TO_WP_SCALE = 12.0; // points-margin → win-prob logistic scale
// v6.6: ML trust bumped to 0.70, ML floor lowered to 0.02 (kill phantom dog
// edges). Totals/spreads kept tighter — see MLB model for rationale.
export const MODEL_TRUST_WEIGHT = 0.7;
export const MODEL_TRUST_WEIGHT_TOTALS = 0.45;
export const MODEL_TRUST_WEIGHT_SPREADS = 0.55;
export const PROB_CLAMP_LO = 0.02;
export const PROB_CLAMP_HI = 0.85;
export const PROB_CLAMP_TOTALS: readonly [number, number] = [0.3, 0.7];
export const PROB_CLAMP_SPREADS: readonly [number, number] = [0.3, 0.7];
export const NBA_B2B_PTS = 2.2;       // points docked from a team on zero rest (back-to-back)
export const NBA_REST_EDGE_PTS = 0.6; // extra points per day of rest advantage (capped)

export interface TeamHoopStats {
  available: boolean;
  ortg?: number | null; // offensive rating
  drtg?: number | null; // defensive rating
  pace?: number | null; // possessions per 48
}

export interface NbaModelContext {
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homeStats: TeamHoopStats | Record<string, never>;
  awayStats: TeamHoopStats | Record<string, never>;
  homeFairProb?: number | null;
  awayFairProb?: number | null;
  // Rest days since each team's previous game (0 = back-to-back). Optional.
  homeRestDays?: number | null;
  awayRestDays?: number | null;
  // Net point swing from injuries (positive favors home). A star OUT is ~4-7 pts.
  homeInjuryPts?: number | null; // points docked from home for its own injuries
  awayInjuryPts?: number | null; // points docked from away for its own injuries
}

export interface NbaModelResult {
  canModel: boolean;
  reason: string | null;
  projHomePoints: number;
  projAwayPoints: number;
  expectedTotalPoints: number;
  homeWinProb: number;
  awayWinProb: number;
  homeWinProbFormula: number;
  shrinkageApplied: boolean;
  clampHit: boolean;
  fairHomeMl: number | null;
  fairAwayMl: number | null;
  dataQualityTier: string;
  hardPassReason: string | null;
  homeOrtg: number | null;
  awayOrtg: number | null;
  homePace: number | null;
  awayPace: number | null;
  modelNotes: string[];
}

function sf(v: unknown, dflt: number | null = null): number | null {
  if (v === null || v === undefined) return dflt;
  const f = Number(v);
  return Number.isNaN(f) ? dflt : f;
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function predictGame(ctx: NbaModelContext): NbaModelResult {
  const warnings: string[] = [];
  const home = (ctx.homeStats ?? {}) as TeamHoopStats;
  const away = (ctx.awayStats ?? {}) as TeamHoopStats;

  const homeOrtg = (home.available ? sf(home.ortg) : null) ?? NBA_LG_ORTG;
  const awayOrtg = (away.available ? sf(away.ortg) : null) ?? NBA_LG_ORTG;
  const homeDrtg = (home.available ? sf(home.drtg) : null) ?? NBA_LG_ORTG;
  const awayDrtg = (away.available ? sf(away.drtg) : null) ?? NBA_LG_ORTG;
  const homePace = (home.available ? sf(home.pace) : null) ?? NBA_LG_PACE;
  const awayPace = (away.available ? sf(away.pace) : null) ?? NBA_LG_PACE;

  if (!home.available) warnings.push("home team stats missing — using league ORtg/pace");
  if (!away.available) warnings.push("away team stats missing — using league ORtg/pace");

  // Blended game pace (possessions). Each team's efficiency is the average of
  // its own ORtg and the opponent's DRtg, expressed per 100 possessions.
  const pace = (homePace + awayPace) / 2;
  const homeEff = (homeOrtg + awayDrtg) / 2;
  const awayEff = (awayOrtg + homeDrtg) / 2;

  let projHome = (homeEff * pace) / 100 + NBA_HOME_PTS;
  let projAway = (awayEff * pace) / 100;

  // Rest / back-to-back adjustment. A team on zero rest loses NBA_B2B_PTS; a
  // rest-days edge adds up to ~2 points (capped at 3 days of advantage).
  const homeRest = sf(ctx.homeRestDays);
  const awayRest = sf(ctx.awayRestDays);
  if (homeRest !== null && homeRest <= 0) { projHome -= NBA_B2B_PTS; warnings.push("home on a back-to-back — points docked"); }
  if (awayRest !== null && awayRest <= 0) { projAway -= NBA_B2B_PTS; warnings.push("away on a back-to-back — points docked"); }
  if (homeRest !== null && awayRest !== null) {
    const restDiff = Math.max(-3, Math.min(3, homeRest - awayRest));
    const restPts = restDiff * NBA_REST_EDGE_PTS;
    projHome += restPts / 2;
    projAway -= restPts / 2;
    if (Math.abs(restDiff) >= 2) warnings.push(`rest edge: ${restDiff > 0 ? "home" : "away"} +${Math.abs(restDiff)} days`);
  }

  // Injury adjustment — points removed from each side for its own absences.
  const homeInj = sf(ctx.homeInjuryPts) ?? 0;
  const awayInj = sf(ctx.awayInjuryPts) ?? 0;
  if (homeInj > 0) { projHome -= homeInj; warnings.push(`home injuries: -${homeInj} pts`); }
  if (awayInj > 0) { projAway -= awayInj; warnings.push(`away injuries: -${awayInj} pts`); }

  projHome = Math.max(80, projHome);
  projAway = Math.max(80, projAway);

  const margin = projHome - projAway;
  const homeProbFormula = logistic(margin / MARGIN_TO_WP_SCALE);

  // Market shrinkage.
  const homeFairMkt = sf(ctx.homeFairProb);
  let homeProb: number;
  let shrinkageApplied: boolean;
  if (homeFairMkt === null || homeFairMkt <= 0 || homeFairMkt >= 1) {
    homeProb = homeProbFormula;
    shrinkageApplied = false;
    warnings.push("no market prior — formula unshrunk");
  } else {
    const w = MODEL_TRUST_WEIGHT;
    homeProb = w * homeProbFormula + (1 - w) * homeFairMkt;
    shrinkageApplied = true;
  }

  const homeProbRaw = homeProb;
  homeProb = Math.max(PROB_CLAMP_LO, Math.min(PROB_CLAMP_HI, homeProb));
  const clampHit = Math.abs(homeProbRaw - homeProb) > 0.001;
  const awayProb = round4(1 - homeProb);
  homeProb = round4(homeProb);

  return {
    canModel: true,
    reason: null,
    projHomePoints: round1(projHome),
    projAwayPoints: round1(projAway),
    expectedTotalPoints: round1(projHome + projAway),
    homeWinProb: homeProb,
    awayWinProb: awayProb,
    homeWinProbFormula: round4(homeProbFormula),
    shrinkageApplied,
    clampHit,
    fairHomeMl: probToAmerican(homeProb),
    fairAwayMl: probToAmerican(awayProb),
    dataQualityTier: home.available && away.available ? "HIGH" : "MEDIUM",
    hardPassReason: null,
    homeOrtg: home.available ? sf(home.ortg) : null,
    awayOrtg: away.available ? sf(away.ortg) : null,
    homePace: home.available ? sf(home.pace) : null,
    awayPace: away.available ? sf(away.pace) : null,
    modelNotes: warnings,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
