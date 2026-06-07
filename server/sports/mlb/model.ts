// MLB win-probability + run-prediction model — ported from sports-engine
// sports/mlb/model.py. Constants locked per SPEC §4.

import { americanToProb, probToAmerican } from "../../core/odds";
import {
  parkFactorForTeam,
  weatherRunAdjust,
  windDirectionRunAdjust,
  type WeatherRefined,
} from "./weather";
import { bullpenRunAdjustment, type BullpenStats } from "./bullpen";
import { isElitePitcher, dataQualityTier, type PitcherStats } from "./pitchers";
import { pythagenpatWinPct, LG_AVG_RPG, type TeamOffense } from "./ratings";

// ── Tunable constants (SPEC §4) ───────────────────────────────────
export const MLB_LG_ERA = 4.2;
export const MLB_HFA_RUNS = 0.12;
export const MLB_SP_ADJ_LO = 0.55;
export const MLB_SP_ADJ_HI = 1.55;
export const PROB_CLAMP_LO = 0.15;
export const PROB_CLAMP_HI = 0.85;
export const MODEL_TRUST_WEIGHT = 0.45; // raised from 0.35 on 2026-05-10
export const TRAP_RAW_THRESHOLD = 10.0;
export const TRAP_SHRUNK_THRESHOLD = 5.0;
export const ELITE_FADE_PP = 12.0;
export const DEFAULT_STARTER_IP_SHARE = 5.5 / 9.0; // 0.611
export const BULLPEN_WEIGHT_DAMPENER = 0.51;

export interface ModelContext {
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homeSpStats: PitcherStats | Record<string, never>;
  awaySpStats: PitcherStats | Record<string, never>;
  homeOffStats: TeamOffense | Record<string, never>;
  awayOffStats: TeamOffense | Record<string, never>;
  homeBullpen?: BullpenStats | null;
  awayBullpen?: BullpenStats | null;
  venueTriCode?: string; // home team tri-code for park factor
  homeFairProb?: number | null; // market prior
  awayFairProb?: number | null;
  weatherRefined?: WeatherRefined | null;
  weatherRaw?: { windRunAdj?: number | null } | null;
  starterIpShare?: number;
}

export interface ModelResult {
  canModel: boolean;
  reason: string | null;
  projHomeScore: number;
  projAwayScore: number;
  expectedTotalRuns: number;
  homeWinProb: number;
  awayWinProb: number;
  homeWinProbRaw: number;
  homeWinProbFormula: number;
  shrinkageApplied: boolean;
  modelTrustWeight: number;
  clampHit: boolean;
  fairHomeMl: number | null;
  fairAwayMl: number | null;
  isSparseModel: boolean;
  sparseWarnings: string[];
  dataQualityTier: string;
  hardPassReason: string | null;
  trapSignal: boolean;
  trapGapPp: number | null;
  eliteFadeHome: boolean;
  eliteFadeAway: boolean;
  bullpenAdjHome: number;
  bullpenAdjAway: number;
  parkFactor: number;
  method: string;
  modelNotes: string[];
}

function safeFloat(v: unknown, dflt: number | null = null): number | null {
  if (v === null || v === undefined) return dflt;
  const f = Number(v);
  return Number.isNaN(f) ? dflt : f;
}

function starterProxy(stats: Record<string, unknown>, warnings: string[], side: string): number {
  if (!stats || !stats.available) {
    warnings.push(`${side} SP: no stats — using LG ERA ${MLB_LG_ERA}`);
    return MLB_LG_ERA;
  }
  const ip = safeFloat(stats.ip, 0) ?? 0;
  const fip = safeFloat(stats.fip);
  const era = safeFloat(stats.era);
  if (fip !== null && ip >= 10) return fip;
  if (era !== null && ip >= 10) return era;
  if (fip !== null) return fip;
  if (era !== null) return era;
  warnings.push(`${side} SP: no FIP/ERA — using LG avg`);
  return MLB_LG_ERA;
}

function teamRpg(off: Record<string, unknown>, warnings: string[], side: string): number {
  if (!off || !off.available) {
    warnings.push(`${side}: no offense data — using LG RPG ${LG_AVG_RPG}`);
    return LG_AVG_RPG;
  }
  const rpg = safeFloat(off.rpg);
  if (rpg !== null && rpg > 0) return rpg;
  const ops = safeFloat(off.ops);
  if (ops !== null && ops > 0) {
    return Math.max(2.5, Math.min(8.0, 19.5 * ops - 9.5));
  }
  warnings.push(`${side}: no RPG/OPS — using LG avg`);
  return LG_AVG_RPG;
}

function spAdj(eraProxy: number): number {
  return Math.max(MLB_SP_ADJ_LO, Math.min(MLB_SP_ADJ_HI, eraProxy / MLB_LG_ERA));
}

export function predictGame(ctx: ModelContext): ModelResult {
  const warnings: string[] = [];
  const methodLog: string[] = [];

  const homeTeamFull = ctx.homeTeamFull || ctx.homeTeam || "?";
  const awayTeamFull = ctx.awayTeamFull || ctx.awayTeam || "?";

  const homeSp = (ctx.homeSpStats as PitcherStats) ?? ({} as PitcherStats);
  const awaySp = (ctx.awaySpStats as PitcherStats) ?? ({} as PitcherStats);

  // Step 0: data-quality gate
  const quality = dataQualityTier(homeSp, awaySp);
  let hardPassReason: string | null = null;
  if (quality === "PASS_HARD_GATE") {
    const reasons: string[] = [];
    if (homeSp.classification === "HARD_PASS" || homeSp.classification === "NO_DATA") {
      reasons.push(`home SP ${homeSp.pitcher ?? "TBD"}: ${homeSp.hardPassReason ?? homeSp.classification}`);
    }
    if (awaySp.classification === "HARD_PASS" || awaySp.classification === "NO_DATA") {
      reasons.push(`away SP ${awaySp.pitcher ?? "TBD"}: ${awaySp.hardPassReason ?? awaySp.classification}`);
    }
    hardPassReason = reasons.join(" | ");
    warnings.push(`HARD PASS gate: ${hardPassReason}`);
  }

  // Step A: starter quality
  const homeSpProxy = starterProxy(homeSp as unknown as Record<string, unknown>, warnings, "home");
  const awaySpProxy = starterProxy(awaySp as unknown as Record<string, unknown>, warnings, "away");

  // Step B: team offense
  const homeRpg = teamRpg(ctx.homeOffStats as Record<string, unknown>, warnings, "home");
  const awayRpg = teamRpg(ctx.awayOffStats as Record<string, unknown>, warnings, "away");

  // Step C: park factor
  const parkF = parkFactorForTeam(ctx.venueTriCode ?? ctx.homeTeam);
  if (parkF !== 1.0) methodLog.push(`park(${parkF.toFixed(2)})`);

  // Step D: weather
  const weatherAdj = ctx.weatherRefined ? weatherRunAdjust(ctx.weatherRefined) : 0.0;
  const windResult = ctx.weatherRaw ? windDirectionRunAdjust(homeTeamFull, ctx.weatherRaw) : null;
  const windAdj = windResult ? windResult.runAdj : 0.0;
  const totalWeatherAdj = weatherAdj + windAdj;

  // Step E: bullpen factor (dampened)
  const homeBpRaw = bullpenRunAdjustment(ctx.homeBullpen);
  const awayBpRaw = bullpenRunAdjustment(ctx.awayBullpen);
  const homeBpAdj = homeBpRaw * BULLPEN_WEIGHT_DAMPENER;
  const awayBpAdj = awayBpRaw * BULLPEN_WEIGHT_DAMPENER;

  // Step F: expected runs
  const spShare = ctx.starterIpShare ?? DEFAULT_STARTER_IP_SHARE;
  const bpShare = 1.0 - spShare;

  const awaySpA = spAdj(awaySpProxy);
  const awayBpFactor = 1.0 + awayBpAdj / MLB_LG_ERA;
  let homeExp = homeRpg * (spShare * awaySpA + bpShare * awayBpFactor) * parkF;
  homeExp += MLB_HFA_RUNS;
  homeExp += totalWeatherAdj / 2.0;

  const homeSpA = spAdj(homeSpProxy);
  const homeBpFactor = 1.0 + homeBpAdj / MLB_LG_ERA;
  let awayExp = awayRpg * (spShare * homeSpA + bpShare * homeBpFactor) * parkF;
  awayExp += totalWeatherAdj / 2.0;

  homeExp = Math.max(2.0, homeExp);
  awayExp = Math.max(2.0, awayExp);
  const predictedTotal = round2(homeExp + awayExp);

  // Step G: Pythagenpat + OPS blend
  const homeProbPyth = pythagenpatWinPct(homeExp, awayExp);
  const homeOps = safeFloat((ctx.homeOffStats as Record<string, unknown>)?.ops);
  const awayOps = safeFloat((ctx.awayOffStats as Record<string, unknown>)?.ops);
  let homeProbFormula: number;
  if (homeOps !== null && awayOps !== null && homeOps + awayOps > 0) {
    const opsRatioHome = homeOps / (homeOps + awayOps);
    homeProbFormula = 0.7 * homeProbPyth + 0.3 * opsRatioHome;
  } else {
    homeProbFormula = homeProbPyth;
    warnings.push("OPS blend skipped — OPS unavailable");
  }

  // Step H: market shrinkage
  const homeFairMkt = safeFloat(ctx.homeFairProb);
  let homeProb: number;
  let shrinkageApplied: boolean;
  if (homeFairMkt === null || homeFairMkt <= 0 || homeFairMkt >= 1) {
    warnings.push("No market prior — formula used unshrunk (suspect)");
    homeProb = homeProbFormula;
    shrinkageApplied = false;
  } else {
    const w = MODEL_TRUST_WEIGHT;
    homeProb = w * homeProbFormula + (1.0 - w) * homeFairMkt;
    shrinkageApplied = true;
  }

  // clamp
  const homeProbRaw = homeProb;
  homeProb = Math.max(PROB_CLAMP_LO, Math.min(PROB_CLAMP_HI, homeProb));
  const clampHit = Math.abs(homeProbRaw - homeProb) > 0.001;

  const awayProb = round4(1.0 - homeProb);
  homeProb = round4(homeProb);

  // Step I: sparse detection
  const homeIp = safeFloat(homeSp.ip, 0) ?? 0;
  const awayIp = safeFloat(awaySp.ip, 0) ?? 0;
  const avgIp = (homeIp + awayIp) / 2.0;
  const isSparse = avgIp < 20.0;
  const sparseWarnings: string[] = [];
  if (isSparse) sparseWarnings.push(`Sparse model: avg IP=${avgIp.toFixed(1)}`);

  // Step J: stale-line trap (combo logic)
  let trapSignal = false;
  let trapGapPp: number | null = null;
  if (homeFairMkt !== null) {
    const rawGap = Math.abs(homeProbFormula - homeFairMkt) * 100.0;
    const shrunkEdge = Math.abs((homeProb - homeFairMkt) * 100.0);
    if (rawGap > TRAP_RAW_THRESHOLD && shrunkEdge > TRAP_SHRUNK_THRESHOLD) {
      trapSignal = true;
      trapGapPp = round1(rawGap);
      warnings.push(`TRAP SIGNAL: raw gap=${rawGap.toFixed(1)}pp, shrunk edge=${shrunkEdge.toFixed(1)}pp — downgrade tier by 1`);
    }
  }

  // Step K: elite-pitcher fade
  const eliteFadeHome = isElitePitcher(awaySp); // away SP elite → fade home pick
  const eliteFadeAway = isElitePitcher(homeSp);
  if (eliteFadeHome) warnings.push(`Elite opposing SP: ${awaySp.pitcher} — fade home pick (-${ELITE_FADE_PP}pp)`);
  if (eliteFadeAway) warnings.push(`Elite opposing SP: ${homeSp.pitcher} — fade away pick (-${ELITE_FADE_PP}pp)`);

  return {
    canModel: true,
    reason: null,
    projHomeScore: round2(homeExp),
    projAwayScore: round2(awayExp),
    expectedTotalRuns: predictedTotal,
    homeWinProb: homeProb,
    awayWinProb: awayProb,
    homeWinProbRaw: round4(homeProbRaw),
    homeWinProbFormula: round4(homeProbFormula),
    shrinkageApplied,
    modelTrustWeight: MODEL_TRUST_WEIGHT,
    clampHit,
    fairHomeMl: probToAmerican(homeProb),
    fairAwayMl: probToAmerican(awayProb),
    isSparseModel: isSparse,
    sparseWarnings,
    dataQualityTier: quality,
    hardPassReason,
    trapSignal,
    trapGapPp,
    eliteFadeHome,
    eliteFadeAway,
    bullpenAdjHome: round2(homeBpAdj),
    bullpenAdjAway: round2(awayBpAdj),
    parkFactor: round2(parkF),
    method: methodLog.join(" | "),
    modelNotes: warnings,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
