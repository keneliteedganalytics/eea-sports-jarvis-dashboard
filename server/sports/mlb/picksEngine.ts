// Picks engine — ported from sports-engine sports/mlb/picks_engine.py.
// Confidence (7-component), Kelly sizing, verdict tier, daily 6-pick cap.

import { assignTier, MIN_CONFIDENCE } from "../../core/tier";
import { computeKellyStake, unitsFromStake, unitSize, KELLY_FRACTION, KELLY_CAP_PCT } from "../../core/kelly";
import type { Verdict, Side } from "../../core/types";
import type { ModelResult } from "./model";
import type { PitcherStats } from "./pitchers";
import type { TeamOffense } from "./ratings";

export const ELITE_FADE_PP = 12.0;
export const MAX_PICKS_PER_DAY = 6;
export const BANKROLL_USD = 29000;

export interface GameInput {
  gameId: string;
  gameDate: string;
  gameTimeEt: string;
  venue: string;
  homeTeam: string; // tri-code
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homePitcher?: string;
  awayPitcher?: string;
  mlHome?: number | null;
  mlAway?: number | null;
  mlHomeBook?: string | null;
  mlAwayBook?: string | null;
  homeFairProb?: number | null;
  awayFairProb?: number | null;
  homeSpStats?: PitcherStats | Record<string, never>;
  awaySpStats?: PitcherStats | Record<string, never>;
  homeOffStats?: TeamOffense | Record<string, never>;
  awayOffStats?: TeamOffense | Record<string, never>;
  openHomeMl?: number | null;
  openAwayMl?: number | null;
}

export interface PolymarketData {
  found: boolean;
  pct?: number | null; // 0-100 for pick side
}

export interface BuiltPick {
  gameId: string;
  gameDate: string;
  gameTimeEt: string;
  venue: string;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homePitcher?: string;
  awayPitcher?: string;
  pickSide: Side;
  pickTeam: string;
  pickTeamFull: string;
  pickType: "ML";
  pickMl: number | null;
  pickBook: string | null;
  pickWinProb: number | null;
  pickImpliedProb: number | null;
  fairMl: number | null;
  edgePp: number | null;
  evPer100: number;
  confidence: number;
  units: number;
  kellyStakeDollars: number;
  kellyCapped: boolean;
  verdict: "PLAY" | "PASS" | "LEAN";
  verdictTier: Verdict;
  qualifies: boolean;
  trapSignal: boolean;
  trapGapPp: number | null;
  eliteFadeApplied: boolean;
  dataQualityTier: string;
  hardPassReason: string | null;
  isSparseModel: boolean;
  projHomeScore: number;
  projAwayScore: number;
  expectedTotal: number;
  homeMl: number | null;
  awayMl: number | null;
  openHomeMl: number | null;
  openAwayMl: number | null;
  homeFairProb: number | null;
  awayFairProb: number | null;
  homeWinProb: number | null;
  awayWinProb: number | null;
  homeSp: Record<string, unknown>;
  awaySp: Record<string, unknown>;
  polymarket: PolymarketData;
  modelNotes: string[];
}

// 7-component confidence with elite-fade & sparse penalties (MLB variant).
export function computeConfidence(ctx: {
  edgePp: number | null;
  evPer100: number;
  isSparseModel: boolean;
  eliteFadeApplied: boolean;
  pickSide: Side;
  homeSp: Record<string, unknown>;
  awaySp: Record<string, unknown>;
  homeOff: Record<string, unknown>;
  awayOff: Record<string, unknown>;
  pickWinProb: number | null;
  polymarket?: PolymarketData | null;
}): number {
  let score = 30.0;

  const edgePp = Math.abs(ctx.edgePp ?? 0);
  const ev = ctx.evPer100 ?? 0;

  const hFip = numOrNull(ctx.homeSp.fip);
  const hEra = numOrNull(ctx.homeSp.era);
  const aFip = numOrNull(ctx.awaySp.fip);
  const aEra = numOrNull(ctx.awaySp.era);
  const hOps = numOrNull(ctx.homeOff.ops);
  const aOps = numOrNull(ctx.awayOff.ops);

  // 1. edge
  score += Math.min(25.0, edgePp * 5.0);

  // 2. data completeness
  if (hFip !== null || hEra !== null) score += 5.0;
  if (aFip !== null || aEra !== null) score += 5.0;
  if (hOps !== null) score += 5.0;
  if (aOps !== null) score += 5.0;

  // 3. sample size
  const hIp = numOrNull(ctx.homeSp.ip) ?? 0;
  const aIp = numOrNull(ctx.awaySp.ip) ?? 0;
  const avgIp = (hIp + aIp) / 2.0;
  score += Math.min(10.0, Math.max(0.0, (avgIp - 5.0) / 4.5));

  // 4. +EV
  if (ev > 0) score += 5.0;

  // 5. signal alignment
  const targetHome = ctx.pickSide === "home";
  const ourFip = targetHome ? hFip : aFip;
  const oppFip = targetHome ? aFip : hFip;
  const ourOps = targetHome ? hOps : aOps;
  const oppOps = targetHome ? aOps : hOps;
  let fipAligned = false;
  let opsAligned = false;
  if (ourFip !== null && oppFip !== null) fipAligned = ourFip < oppFip;
  if (ourOps !== null && oppOps !== null) opsAligned = ourOps > oppOps;
  if (fipAligned && opsAligned) score += 5.0;
  else if (fipAligned || opsAligned) score += 2.0;

  // 6. polymarket agreement
  if (ctx.polymarket?.found && ctx.polymarket.pct !== null && ctx.polymarket.pct !== undefined) {
    const polyP = ctx.polymarket.pct / 100.0;
    const ourWp = ctx.pickWinProb ?? 0.5;
    if (polyP >= 0.55 && ourWp >= 0.5) score += 4.0;
    else if (polyP >= 0.45 && ourWp >= 0.5) score += 1.5;
  }

  // 7. sparse penalty
  if (ctx.isSparseModel) {
    if (avgIp < 10) score -= 10.0;
    else if (avgIp < 25) score -= Math.max(0, 10.0 - (avgIp - 10.0) * 0.47);
    else if (avgIp < 40) score -= 3.0;
  }

  // 8. elite fade
  if (ctx.eliteFadeApplied) score -= ELITE_FADE_PP;

  return Math.min(99, Math.max(0, Math.round(score)));
}

export function computeEv(modelProb: number | null, americanOdds: number | null, stake = 100.0): number {
  if (modelProb === null || americanOdds === null) return 0.0;
  const p = modelProb;
  const q = 1.0 - p;
  const profitIfWin = americanOdds > 0 ? stake * (americanOdds / 100.0) : stake * (100.0 / Math.abs(americanOdds));
  return round2(p * profitIfWin - q * stake);
}

export function buildPick(
  game: GameInput,
  model: ModelResult,
  bankroll = BANKROLL_USD,
  polymarketData?: PolymarketData,
): BuiltPick {
  const homeFull = game.homeTeamFull;
  const awayFull = game.awayTeamFull;
  const homeSp = (game.homeSpStats ?? {}) as Record<string, unknown>;
  const awaySp = (game.awaySpStats ?? {}) as Record<string, unknown>;
  const homeOff = (game.homeOffStats ?? {}) as Record<string, unknown>;
  const awayOff = (game.awayOffStats ?? {}) as Record<string, unknown>;

  const homeFairMkt = game.homeFairProb ?? null;
  const awayFairMkt = game.awayFairProb ?? null;

  // hard pass gate
  let hardPass = model.dataQualityTier === "PASS_HARD_GATE" || Boolean(model.hardPassReason);
  let hardPassReason = model.hardPassReason;
  if (!model.canModel) {
    hardPass = true;
    hardPassReason = hardPassReason ?? model.reason ?? "model_skipped";
  }

  // Safety guard (live-test 6/7): when BOTH starters lack stats, the model is
  // leaning entirely on the market prior — so a large moneyline is a market
  // signal we cannot beat, not an edge. Hard-pass extreme/heavy lines outright.
  const bothSpMissing = !homeSp.available && !awaySp.available;
  if (bothSpMissing) {
    const hMl = Math.abs(game.mlHome ?? 0);
    const aMl = Math.abs(game.mlAway ?? 0);
    const maxMl = Math.max(hMl, aMl);
    if (maxMl > 400) {
      hardPass = true;
      hardPassReason = "missing_pitcher_data_with_extreme_line";
    } else if (maxMl > 250) {
      hardPass = true;
      hardPassReason = "missing_pitcher_data_with_heavy_favorite";
    }
  }

  // pick side (max edge)
  const homeWp = model.homeWinProb;
  const awayWp = model.awayWinProb;
  const homeEdge = homeWp !== null && homeFairMkt !== null ? (homeWp - homeFairMkt) * 100 : null;
  const awayEdge = awayWp !== null && awayFairMkt !== null ? (awayWp - awayFairMkt) * 100 : null;
  const hVal = homeEdge ?? -999;
  const aVal = awayEdge ?? -999;

  let pickSide: Side;
  let pickTeam: string;
  let pickTeamFull: string;
  let pickEdge: number | null;
  let pickWp: number | null;
  let pickMl: number | null;
  let pickBook: string | null;
  let pickFairMkt: number | null;
  let eliteFadeApplied: boolean;

  if (hVal >= aVal) {
    pickSide = "home";
    pickTeam = game.homeTeam;
    pickTeamFull = homeFull;
    pickEdge = homeEdge;
    pickWp = homeWp;
    pickMl = game.mlHome ?? null;
    pickBook = game.mlHomeBook ?? null;
    pickFairMkt = homeFairMkt;
    eliteFadeApplied = model.eliteFadeHome;
  } else {
    pickSide = "away";
    pickTeam = game.awayTeam;
    pickTeamFull = awayFull;
    pickEdge = awayEdge;
    pickWp = awayWp;
    pickMl = game.mlAway ?? null;
    pickBook = game.mlAwayBook ?? null;
    pickFairMkt = awayFairMkt;
    eliteFadeApplied = model.eliteFadeAway;
  }

  const ev = pickWp !== null && pickMl !== null ? computeEv(pickWp, pickMl) : 0.0;

  const confidence = computeConfidence({
    edgePp: pickEdge,
    evPer100: ev,
    isSparseModel: model.isSparseModel,
    eliteFadeApplied,
    pickSide,
    homeSp,
    awaySp,
    homeOff,
    awayOff,
    pickWinProb: pickWp,
    polymarket: polymarketData,
  });

  const polyPct = polymarketData?.found ? (polymarketData.pct ?? null) : null;

  const tier = assignTier({
    edgePp: pickEdge,
    confidence,
    polyPct,
    evPer100: ev,
    hardPass,
    trapCapped: model.trapSignal,
    oddsAmerican: pickMl,
    winProb: pickWp,
  });

  const unit = unitSize(bankroll);
  const kelly =
    pickWp !== null && pickMl !== null && !hardPass
      ? computeKellyStake(pickWp, pickMl, bankroll, KELLY_FRACTION, KELLY_CAP_PCT)
      : { fullKelly: 0, kellyUsed: 0, finalFraction: 0, stakeDollars: 0, capped: false };
  let rawUnits = unitsFromStake(kelly.stakeDollars, unit);

  const qualifies = ["BONUS", "SNIPER", "EDGE", "RECON", "VALUE"].includes(tier);
  let verdict: "PLAY" | "PASS" | "LEAN";
  if (hardPass || tier === "PASS") verdict = "PASS";
  else if (tier === "LEAN") verdict = "LEAN";
  else if (qualifies) verdict = "PLAY";
  else verdict = "PASS";

  let units = rawUnits;
  let stakeDollars = kelly.stakeDollars;
  if (qualifies && rawUnits < 0.5) {
    units = 0.5;
    stakeDollars = round2(0.5 * unit);
  }

  return {
    gameId: game.gameId,
    gameDate: game.gameDate,
    gameTimeEt: game.gameTimeEt,
    venue: game.venue,
    matchup: `${awayFull} @ ${homeFull}`,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeTeamFull: homeFull,
    awayTeamFull: awayFull,
    homePitcher: game.homePitcher,
    awayPitcher: game.awayPitcher,
    pickSide,
    pickTeam,
    pickTeamFull,
    pickType: "ML",
    pickMl,
    pickBook,
    pickWinProb: pickWp,
    pickImpliedProb: pickFairMkt,
    fairMl: pickSide === "home" ? model.fairHomeMl : model.fairAwayMl,
    edgePp: pickEdge !== null ? round2(pickEdge) : null,
    evPer100: ev,
    confidence,
    units,
    kellyStakeDollars: stakeDollars,
    kellyCapped: kelly.capped,
    verdict,
    verdictTier: tier,
    qualifies,
    trapSignal: model.trapSignal,
    trapGapPp: model.trapGapPp,
    eliteFadeApplied,
    dataQualityTier: model.dataQualityTier,
    hardPassReason,
    isSparseModel: model.isSparseModel,
    projHomeScore: model.projHomeScore,
    projAwayScore: model.projAwayScore,
    expectedTotal: model.expectedTotalRuns,
    homeMl: game.mlHome ?? null,
    awayMl: game.mlAway ?? null,
    openHomeMl: game.openHomeMl ?? null,
    openAwayMl: game.openAwayMl ?? null,
    homeFairProb: homeFairMkt,
    awayFairProb: awayFairMkt,
    homeWinProb: homeWp,
    awayWinProb: awayWp,
    homeSp,
    awaySp,
    polymarket: polymarketData ?? { found: false, pct: null },
    modelNotes: model.modelNotes,
  };
}

// Daily 6-pick cap: sort by tier rank then edge; surplus actionable → LEAN.
const TIER_RANK: Record<Verdict, number> = {
  BONUS: 0,
  SNIPER: 1,
  EDGE: 2,
  RECON: 3,
  VALUE: 4,
  LEAN: 5,
  PASS: 6,
};

export function applyDailyCap(picks: BuiltPick[], maxPicks = MAX_PICKS_PER_DAY): BuiltPick[] {
  const sorted = [...picks].sort((a, b) => {
    const r = TIER_RANK[a.verdictTier] - TIER_RANK[b.verdictTier];
    if (r !== 0) return r;
    return (b.edgePp ?? -999) - (a.edgePp ?? -999);
  });

  let actionableCount = 0;
  for (const p of sorted) {
    if (p.qualifies) {
      if (actionableCount >= maxPicks) {
        // downgrade surplus to LEAN
        p.verdictTier = "LEAN";
        p.verdict = "LEAN";
        p.qualifies = false;
        p.units = 0;
        p.kellyStakeDollars = 0;
      } else {
        actionableCount += 1;
      }
    }
  }
  return sorted;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
