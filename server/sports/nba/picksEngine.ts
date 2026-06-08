// NBA picks engine — mirrors the MLB/NHL structure: confidence, Kelly sizing,
// tier, ML/spread/total markets, daily-cap 6, and an NBA hard-pass guard.

import { assignTier } from "../../core/tier";
import { computeKellyStake, unitsFromStake, unitSize, KELLY_FRACTION, KELLY_CAP_PCT } from "../../core/kelly";
import { buildTwoWayMarket } from "../../core/markets";
import { emptyMarket, type Market, type MarketSet, type Side, type Verdict } from "../../core/types";
import type { BuiltPick } from "../mlb/picksEngine";
import type { NbaModelResult, TeamHoopStats } from "./model";

export const BANKROLL_USD = 29000;
export const MAX_PICKS_PER_DAY = 6;
const SPREAD_MARGIN_SCALE = 6.5; // points-diff → cover prob scale
const TOTAL_SCALE = 9.0;

export interface NbaGameInput {
  gameId: string;
  gameDate: string;
  gameTimeEt: string;
  venue: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  mlHome?: number | null;
  mlAway?: number | null;
  mlHomeBook?: string | null;
  mlAwayBook?: string | null;
  homeFairProb?: number | null;
  awayFairProb?: number | null;
  spreadHomeLine?: number | null;
  spreadHomePrice?: number | null;
  spreadAwayLine?: number | null;
  spreadAwayPrice?: number | null;
  spreadBook?: string | null;
  totalLine?: number | null;
  totalOverPrice?: number | null;
  totalUnderPrice?: number | null;
  totalBook?: string | null;
  // Carrier fields threaded from the adapter into the model (not serialized).
  _homeStats?: TeamHoopStats | Record<string, never>;
  _awayStats?: TeamHoopStats | Record<string, never>;
}

// Possession-model confidence: base 30, edge magnitude, data completeness, alignment.
function computeConfidence(edgePp: number | null, model: NbaModelResult, pickSide: Side): number {
  let score = 30;
  score += Math.min(25, Math.abs(edgePp ?? 0) * 5);
  if (model.homeOrtg !== null) score += 5;
  if (model.awayOrtg !== null) score += 5;
  if (model.homePace !== null) score += 5;
  if (model.awayPace !== null) score += 5;
  if (model.shrinkageApplied) score += 5;
  // alignment: pick side has the higher ORtg.
  const ourOrtg = pickSide === "home" ? model.homeOrtg : model.awayOrtg;
  const oppOrtg = pickSide === "home" ? model.awayOrtg : model.homeOrtg;
  if (ourOrtg !== null && oppOrtg !== null && ourOrtg > oppOrtg) score += 5;
  return Math.min(99, Math.max(0, Math.round(score)));
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
function fmtAmerican(ml: number | null): string {
  if (ml === null) return "";
  return ml > 0 ? `+${ml}` : `${ml}`;
}
function fmtLine(line: number | null): string {
  if (line === null) return "";
  return line > 0 ? `+${line}` : `${line}`;
}

export function buildPick(game: NbaGameInput, model: NbaModelResult, bankroll = BANKROLL_USD): BuiltPick {
  const homeFair = game.homeFairProb ?? null;
  const awayFair = game.awayFairProb ?? null;

  // Hard-pass guard: pace/ORtg missing AND total is extreme (> 240 or < 200).
  let hardPass = Boolean(model.hardPassReason);
  let hardPassReason = model.hardPassReason;
  const statsMissing = model.homePace === null || model.awayPace === null || model.homeOrtg === null || model.awayOrtg === null;
  if (statsMissing && game.totalLine != null && (game.totalLine > 240 || game.totalLine < 200)) {
    hardPass = true;
    hardPassReason = "missing_efficiency_data_with_extreme_total";
  }

  const homeEdge = homeFair !== null ? (model.homeWinProb - homeFair) * 100 : null;
  const awayEdge = awayFair !== null ? (model.awayWinProb - awayFair) * 100 : null;
  const hVal = homeEdge ?? -999;
  const aVal = awayEdge ?? -999;

  const pickSide: Side = hVal >= aVal ? "home" : "away";
  const pickTeam = pickSide === "home" ? game.homeTeam : game.awayTeam;
  const pickTeamFull = pickSide === "home" ? game.homeTeamFull : game.awayTeamFull;
  const pickEdge = pickSide === "home" ? homeEdge : awayEdge;
  const pickWp = pickSide === "home" ? model.homeWinProb : model.awayWinProb;
  const pickMl = pickSide === "home" ? game.mlHome ?? null : game.mlAway ?? null;
  const pickBook = pickSide === "home" ? game.mlHomeBook ?? null : game.mlAwayBook ?? null;
  const pickFair = pickSide === "home" ? homeFair : awayFair;

  const confidence = computeConfidence(pickEdge, model, pickSide);

  const tier: Verdict = assignTier({
    edgePp: pickEdge,
    confidence,
    polyPct: null,
    hardPass,
    oddsAmerican: pickMl,
    winProb: pickWp,
  });

  const unit = unitSize(bankroll);
  const kelly =
    pickWp !== null && pickMl !== null && !hardPass
      ? computeKellyStake(pickWp, pickMl, bankroll, KELLY_FRACTION, KELLY_CAP_PCT)
      : { stakeDollars: 0, capped: false, fullKelly: 0, kellyUsed: 0, finalFraction: 0 };
  let units = unitsFromStake(kelly.stakeDollars, unit);

  const qualifies = ["BONUS", "SNIPER", "EDGE", "RECON", "VALUE"].includes(tier);
  let verdict: "PLAY" | "PASS" | "LEAN";
  if (hardPass || tier === "PASS") verdict = "PASS";
  else if (tier === "LEAN") verdict = "LEAN";
  else if (qualifies) verdict = "PLAY";
  else verdict = "PASS";
  if (qualifies && units < 0.5) units = 0.5;

  const markets = buildMarkets(game, model, pickSide, pickTeam, pickEdge, pickMl, pickBook, tier, units, hardPass);

  return {
    sport: "nba",
    gameId: game.gameId,
    gameDate: game.gameDate,
    gameTimeEt: game.gameTimeEt,
    venue: game.venue,
    matchup: `${game.awayTeamFull} @ ${game.homeTeamFull}`,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeTeamFull: game.homeTeamFull,
    awayTeamFull: game.awayTeamFull,
    homePitcher: undefined,
    awayPitcher: undefined,
    pickSide,
    pickTeam,
    pickTeamFull,
    pickType: "ML",
    markets,
    pickMl,
    pickBook,
    pickWinProb: pickWp,
    pickImpliedProb: pickFair,
    fairMl: pickSide === "home" ? model.fairHomeMl : model.fairAwayMl,
    edgePp: pickEdge !== null ? round2(pickEdge) : null,
    evPer100: 0,
    confidence,
    units: hardPass ? 0 : units,
    kellyStakeDollars: hardPass ? 0 : kelly.stakeDollars,
    kellyCapped: kelly.capped,
    verdict,
    verdictTier: hardPass ? "PASS" : tier,
    qualifies: hardPass ? false : qualifies,
    trapSignal: false,
    trapGapPp: null,
    eliteFadeApplied: false,
    dataQualityTier: model.dataQualityTier,
    hardPassReason,
    isSparseModel: false,
    projHomeScore: model.projHomePoints,
    projAwayScore: model.projAwayPoints,
    expectedTotal: model.expectedTotalPoints,
    homeMl: game.mlHome ?? null,
    awayMl: game.mlAway ?? null,
    openHomeMl: null,
    openAwayMl: null,
    homeFairProb: homeFair,
    awayFairProb: awayFair,
    homeWinProb: model.homeWinProb,
    awayWinProb: model.awayWinProb,
    homeSp: {},
    awaySp: {},
    polymarket: { found: false, pct: null },
    modelNotes: model.modelNotes,
  };
}

function buildMarkets(
  game: NbaGameInput,
  model: NbaModelResult,
  pickSide: Side,
  pickTeam: string,
  pickEdge: number | null,
  pickMl: number | null,
  pickBook: string | null,
  pickTier: Verdict,
  pickUnits: number,
  hardPass: boolean,
): MarketSet {
  const ml: Market = {
    available: pickMl !== null,
    pick: pickMl !== null ? `${pickTeam} ML ${fmtAmerican(pickMl)}` : null,
    line: null,
    priceAmerican: pickMl,
    fairLine: pickSide === "home" ? model.fairHomeMl : model.fairAwayMl,
    edgePp: pickEdge !== null ? round2(pickEdge) : null,
    tier: hardPass ? "PASS" : pickTier,
    units: hardPass ? 0 : pickUnits,
    side: pickSide,
    book: pickBook,
  };
  if (hardPass) return { ml: { ...ml, tier: "PASS", units: 0 }, spread: emptyMarket(), total: emptyMarket() };

  const margin = model.projHomePoints - model.projAwayPoints;

  let spread: Market = emptyMarket();
  if (game.spreadHomePrice != null && game.spreadAwayPrice != null) {
    const homeLine = game.spreadHomeLine ?? -2.5;
    const homeCoverProb = logistic((margin + homeLine) / SPREAD_MARGIN_SCALE);
    spread = buildTwoWayMarket(
      {
        aLabel: "home", aLine: homeLine, aPrice: game.spreadHomePrice,
        bLabel: "away", bLine: game.spreadAwayLine ?? -homeLine, bPrice: game.spreadAwayPrice,
        book: game.spreadBook ?? null,
      },
      homeCoverProb,
      BANKROLL_USD,
      (side, line, price) => `${side === "a" ? game.homeTeam : game.awayTeam} ${fmtLine(line)} (${fmtAmerican(price)})`,
    );
  }

  let total: Market = emptyMarket();
  if (game.totalOverPrice != null && game.totalUnderPrice != null && game.totalLine != null) {
    const overProb = logistic((model.expectedTotalPoints - game.totalLine) / TOTAL_SCALE);
    total = buildTwoWayMarket(
      {
        aLabel: "over", aLine: game.totalLine, aPrice: game.totalOverPrice,
        bLabel: "under", bLine: game.totalLine, bPrice: game.totalUnderPrice,
        book: game.totalBook ?? null,
      },
      overProb,
      BANKROLL_USD,
      (side, line, price) => `${side === "a" ? "Over" : "Under"} ${line} (${fmtAmerican(price)})`,
    );
  }

  return { ml, spread, total };
}

const TIER_RANK: Record<Verdict, number> = {
  BONUS: 0, SNIPER: 1, EDGE: 2, RECON: 3, VALUE: 4, LEAN: 5, PASS: 6,
};

export function applyDailyCap(picks: BuiltPick[], maxPicks = MAX_PICKS_PER_DAY): BuiltPick[] {
  const sorted = [...picks].sort((a, b) => {
    const r = TIER_RANK[a.verdictTier] - TIER_RANK[b.verdictTier];
    if (r !== 0) return r;
    return (b.edgePp ?? -999) - (a.edgePp ?? -999);
  });
  let count = 0;
  for (const p of sorted) {
    if (p.qualifies) {
      if (count >= maxPicks) {
        p.verdictTier = "LEAN";
        p.verdict = "LEAN";
        p.qualifies = false;
        p.units = 0;
        p.kellyStakeDollars = 0;
      } else count++;
    }
  }
  return sorted;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
