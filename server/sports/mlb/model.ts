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
import { umpireShortName, type UmpireAdjustment } from "./umpires";
import { type AbsAdjustment } from "./abs";
import type { PitcherSabermetrics } from "./pitcherSabermetrics";
import type { TeamOffenseSaber } from "./teamOffenseSaber";
import { deltaVsOpposingHand, type HandednessSplit } from "./handednessSplits";

// ── Tunable constants (SPEC §4) ───────────────────────────────────
export const MLB_LG_ERA = 4.2;
export const MLB_HFA_RUNS = 0.12;
export const MLB_SP_ADJ_LO = 0.55;
export const MLB_SP_ADJ_HI = 1.55;
// v6.6: lower the ML floor so a true long-shot dog stays a long-shot instead of
// being forced up to 15% (which manufactured phantom edges at the tails). Upper
// ceiling unchanged. Totals/spreads keep the tighter [0.30, 0.70] band because
// those markets are sharper than our model at the extremes.
export const PROB_CLAMP_LO = 0.02; // ML floor (was 0.15)
export const PROB_CLAMP_HI = 0.85;
export const PROB_CLAMP_TOTALS: readonly [number, number] = [0.3, 0.7];
export const PROB_CLAMP_SPREADS: readonly [number, number] = [0.3, 0.7];
// v6.6: market-specific model trust. ML trusts the model more (market noise was
// dragging dogs up); totals stay market-led; spreads in between.
export const MODEL_TRUST_WEIGHT = 0.7; // ML (was 0.45)
export const MODEL_TRUST_WEIGHT_TOTALS = 0.45;
export const MODEL_TRUST_WEIGHT_SPREADS = 0.55;
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
  umpireAdjustment?: UmpireAdjustment | null; // HP umpire run/zone profile
  homeAbs?: AbsAdjustment | null; // home SP ABS framing exposure
  awayAbs?: AbsAdjustment | null; // away SP ABS framing exposure
  // v6.10: sabermetric context (additive — all optional, null = no adjustment)
  homeOffenseSaber?: TeamOffenseSaber | null;
  awayOffenseSaber?: TeamOffenseSaber | null;
  homeHandedness?: HandednessSplit | null;    // home batting team splits
  awayHandedness?: HandednessSplit | null;    // away batting team splits
  homePitcherSaber?: PitcherSabermetrics | null; // home SP xFIP/WHIP/K-BB%
  awayPitcherSaber?: PitcherSabermetrics | null; // away SP xFIP/WHIP/K-BB%
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
  umpireName: string | null;
  umpireRunAdj: number;
  absPenaltyHome: number;
  absPenaltyAway: number;
  method: string;
  modelNotes: string[];
  // v6.10 sabermetric outputs (null when data unavailable)
  homeXFIP: number | null;
  awayXFIP: number | null;
  homeWHIP: number | null;
  awayWHIP: number | null;
  homeKBBPct: number | null;
  awayKBBPct: number | null;
  homeWRCplus: number | null;
  awayWRCplus: number | null;
  homeHandednessAdj: number | null;
  awayHandednessAdj: number | null;
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
  const homeSpBase = starterProxy(homeSp as unknown as Record<string, unknown>, warnings, "home");
  const awaySpBase = starterProxy(awaySp as unknown as Record<string, unknown>, warnings, "away");

  // Step A2: ABS framing penalty. A framing-dependent starter loses called
  // strikes under the robo-zone, so we nudge their effective FIP up. Neutral/
  // missing exposure is a 0-run no-op.
  const homeAbsPenalty = ctx.homeAbs?.found ? ctx.homeAbs.fipPenalty : 0;
  const awayAbsPenalty = ctx.awayAbs?.found ? ctx.awayAbs.fipPenalty : 0;
  const homeSpProxy = homeSpBase + homeAbsPenalty;
  const awaySpProxy = awaySpBase + awayAbsPenalty;
  if (homeAbsPenalty > 0)
    methodLog.push(`abs(${homeSp.pitcher ?? "home SP"} +${round2(homeAbsPenalty)}fip)`);
  if (awayAbsPenalty > 0)
    methodLog.push(`abs(${awaySp.pitcher ?? "away SP"} +${round2(awayAbsPenalty)}fip)`);

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

  // Step F2: home-plate umpire — split the per-game run adjustment across both
  // teams. Neutral/missing profiles carry runScoreAdj 0 and are a no-op.
  const ump = ctx.umpireAdjustment ?? null;
  const umpRunAdj = ump?.found ? ump.runScoreAdj : 0;
  if (ump?.name) {
    homeExp += umpRunAdj / 2.0;
    awayExp += umpRunAdj / 2.0;
    if (Math.abs(umpRunAdj) > 0.001) {
      const signed = `${umpRunAdj >= 0 ? "+" : ""}${round2(umpRunAdj)}`;
      methodLog.push(`ump(${umpireShortName(ump.name)}, ${signed}r)`);
    }
  }

  homeExp = Math.max(2.0, homeExp);
  awayExp = Math.max(2.0, awayExp);

  // ── Step F3 (v6.10): sabermetric adjustments ─────────────────────────────
  // Purely additive on top of all existing adjustments.
  const saberNotes: string[] = [];

  // ① Pitcher quality adjustments.
  const homePitcherSaber = ctx.homePitcherSaber ?? null;
  const awayPitcherSaber = ctx.awayPitcherSaber ?? null;

  // xFIP: if xFIP diverges from existing FIP/ERA proxy by >0.30, nudge run projection.
  // 30% weight on xFIP delta, max ±0.25 runs on opponent's expected score.
  function xFIPAdjFn(saber: PitcherSabermetrics | null | undefined, eraProxy: number): number {
    if (!saber || saber.xFIP === null) return 0;
    const delta = saber.xFIP - eraProxy;
    if (Math.abs(delta) < 0.30) return 0;
    const raw = 0.30 * (delta / MLB_LG_ERA) * spShare;
    return Math.max(-0.25, Math.min(0.25, raw));
  }
  const awayXFIPRunAdj = xFIPAdjFn(awayPitcherSaber, awaySpProxy);
  if (awayXFIPRunAdj !== 0) { homeExp += awayXFIPRunAdj; saberNotes.push(`awayXFIP(${round2(awayXFIPRunAdj)})`); }
  const homeXFIPRunAdj = xFIPAdjFn(homePitcherSaber, homeSpProxy);
  if (homeXFIPRunAdj !== 0) { awayExp += homeXFIPRunAdj; saberNotes.push(`homeXFIP(${round2(homeXFIPRunAdj)})`); }

  // K-BB%: controls run output of the opponent.
  function kBBAdjFn(saber: PitcherSabermetrics | null | undefined): number {
    if (!saber || saber.kBBPct === null) return 0;
    if (saber.kBBPct > 0.18) return -0.10; // dominant pitcher
    if (saber.kBBPct < 0.08) return  0.15; // weak pitcher
    return 0;
  }
  const homeKBBRunAdj = kBBAdjFn(homePitcherSaber);
  const awayKBBRunAdj = kBBAdjFn(awayPitcherSaber);
  if (homeKBBRunAdj !== 0) { awayExp += homeKBBRunAdj; saberNotes.push(`homeKBB(${round2(homeKBBRunAdj)})`); }
  if (awayKBBRunAdj !== 0) { homeExp += awayKBBRunAdj; saberNotes.push(`awayKBB(${round2(awayKBBRunAdj)})`); }

  // WHIP >1.40 → +0.10 runs for opponent.
  function whipAdjFn(saber: PitcherSabermetrics | null | undefined): number {
    return (!saber || saber.whip === null) ? 0 : (saber.whip > 1.40 ? 0.10 : 0);
  }
  const homeWHIPRunAdj = whipAdjFn(homePitcherSaber);
  const awayWHIPRunAdj = whipAdjFn(awayPitcherSaber);
  if (homeWHIPRunAdj !== 0) { awayExp += homeWHIPRunAdj; saberNotes.push(`homeWHIP(+${round2(homeWHIPRunAdj)})`); }
  if (awayWHIPRunAdj !== 0) { homeExp += awayWHIPRunAdj; saberNotes.push(`awayWHIP(+${round2(awayWHIPRunAdj)})`); }

  // ② Team offense: wRC+-based adjustment to batting team's expected runs.
  // 100 = league avg. Each 10 wRC+ pts ≈ ±0.20 runs. Clamped ±0.50.
  const homeOffSaber = ctx.homeOffenseSaber ?? null;
  const awayOffSaber = ctx.awayOffenseSaber ?? null;
  function wRCplusAdjFn(saber: TeamOffenseSaber | null | undefined): number {
    if (!saber || saber.wRCplus === null) return 0;
    return Math.max(-0.50, Math.min(0.50, ((saber.wRCplus - 100) / 10) * 0.20));
  }
  const homeOffAdj = wRCplusAdjFn(homeOffSaber);
  const awayOffAdj = wRCplusAdjFn(awayOffSaber);
  if (homeOffAdj !== 0) { homeExp += homeOffAdj; saberNotes.push(`homeWRC+(${round2(homeOffAdj)})`); }
  if (awayOffAdj !== 0) { awayExp += awayOffAdj; saberNotes.push(`awayWRC+(${round2(awayOffAdj)})`); }

  // ③ Handedness: wOBA delta vs. opposing SP's handedness → run adj. Clamped ±0.30.
  const homeHand = ctx.homeHandedness ?? null;
  const awayHand = ctx.awayHandedness ?? null;
  const awaySpHand = (awaySp as PitcherStats).hand ?? null;
  const homeSpHand = (homeSp as PitcherStats).hand ?? null;
  const homeBaseWOBA = homeOffSaber?.wOBA ?? null;
  const awayBaseWOBA = awayOffSaber?.wOBA ?? null;

  let homeHandednessAdj: number | null = null;
  let awayHandednessAdj: number | null = null;

  if (homeHand && awaySpHand && (awaySpHand === 'L' || awaySpHand === 'R') && homeBaseWOBA !== null) {
    const wOBADelta = deltaVsOpposingHand(homeHand, awaySpHand as 'L' | 'R', homeBaseWOBA);
    const rawAdj = (wOBADelta / 0.030) * 0.15;
    homeHandednessAdj = Math.max(-0.30, Math.min(0.30, rawAdj));
    if (Math.abs(homeHandednessAdj) > 0.001) {
      homeExp += homeHandednessAdj;
      saberNotes.push(`homeHand(${round2(homeHandednessAdj)})`);
    }
  }

  if (awayHand && homeSpHand && (homeSpHand === 'L' || homeSpHand === 'R') && awayBaseWOBA !== null) {
    const wOBADelta = deltaVsOpposingHand(awayHand, homeSpHand as 'L' | 'R', awayBaseWOBA);
    const rawAdj = (wOBADelta / 0.030) * 0.15;
    awayHandednessAdj = Math.max(-0.30, Math.min(0.30, rawAdj));
    if (Math.abs(awayHandednessAdj) > 0.001) {
      awayExp += awayHandednessAdj;
      saberNotes.push(`awayHand(${round2(awayHandednessAdj)})`);
    }
  }

  if (saberNotes.length > 0) methodLog.push(`saber(${saberNotes.join(',')})`);

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
    umpireName: ump?.name ?? null,
    umpireRunAdj: round2(umpRunAdj),
    absPenaltyHome: round2(homeAbsPenalty),
    absPenaltyAway: round2(awayAbsPenalty),
    method: methodLog.join(" | "),
    modelNotes: warnings,
    // v6.10 sabermetric outputs
    homeXFIP: homePitcherSaber?.xFIP ?? null,
    awayXFIP: awayPitcherSaber?.xFIP ?? null,
    homeWHIP: homePitcherSaber?.whip ?? null,
    awayWHIP: awayPitcherSaber?.whip ?? null,
    homeKBBPct: homePitcherSaber?.kBBPct ?? null,
    awayKBBPct: awayPitcherSaber?.kBBPct ?? null,
    homeWRCplus: homeOffSaber?.wRCplus ?? null,
    awayWRCplus: awayOffSaber?.wRCplus ?? null,
    homeHandednessAdj: homeHandednessAdj,
    awayHandednessAdj: awayHandednessAdj,
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
