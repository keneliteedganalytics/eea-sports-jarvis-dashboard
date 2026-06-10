// NHL picks engine — mirrors the MLB structure: confidence, EEA flat-unit
// sizing, tier, ML/spread(puck-line)/total markets, daily-cap 6, NHL hard-pass
// guard, and phantom-edge detection.

import { assignTier } from "../../core/tier";
import { convictionUnits, applyJuicePenalty, unitsToStake } from "../../core/sizing";
import { detectPhantomEdge, PHANTOM_NOTE } from "../../core/phantom";
import { buildTwoWayMarket } from "../../core/markets";
import { emptyMarket, type Market, type MarketSet, type Side, type Verdict } from "../../core/types";
import type { BuiltPick, PolymarketData } from "../mlb/picksEngine";
import type { NhlModelResult, GoalieStats, TeamHockeyStats } from "./model";

export const BANKROLL_USD = 25000;
export const MAX_PICKS_PER_DAY = 3;
const PUCK_MARGIN_SCALE = 1.9; // goals-diff → cover prob scale
const TOTAL_SCALE = 2.2;

export interface NhlGameInput {
  gameId: string;
  gameDate: string;
  gameTimeEt: string;
  gameStartIso?: string | null;
  venue: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homeGoalieName?: string | null;
  awayGoalieName?: string | null;
  homeGoalieAvailable?: boolean;
  awayGoalieAvailable?: boolean;
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
  _homeStats?: TeamHockeyStats | Record<string, never>;
  _awayStats?: TeamHockeyStats | Record<string, never>;
  _homeGoalie?: GoalieStats | null;
  _awayGoalie?: GoalieStats | null;
  _publicPct?: number | null;
  _sharpPct?: number | null;
  _polymarketData?: PolymarketData;
}

// Goals-model confidence: base 30, edge magnitude, data completeness, alignment.
function computeConfidence(edgePp: number | null, model: NhlModelResult, pickSide: Side): number {
  let score = 30;
  score += Math.min(25, Math.abs(edgePp ?? 0) * 5);
  if (model.homeXgfPct !== null) score += 5;
  if (model.awayXgfPct !== null) score += 5;
  if (model.homeSvPct !== null) score += 5;
  if (model.awaySvPct !== null) score += 5;
  if (model.shrinkageApplied) score += 5;
  // alignment: pick side has the higher xGF%.
  const ourXgf = pickSide === "home" ? model.homeXgfPct : model.awayXgfPct;
  const oppXgf = pickSide === "home" ? model.awayXgfPct : model.homeXgfPct;
  if (ourXgf !== null && oppXgf !== null && ourXgf > oppXgf) score += 5;
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

export function buildPick(game: NhlGameInput, model: NhlModelResult, bankroll = BANKROLL_USD): BuiltPick {
  const homeFair = game.homeFairProb ?? null;
  const awayFair = game.awayFairProb ?? null;

  // Hard-pass guard: both goalies missing AND line > ±300.
  let hardPass = Boolean(model.hardPassReason);
  let hardPassReason = model.hardPassReason;
  const bothGoaliesMissing = !game.homeGoalieAvailable && !game.awayGoalieAvailable;
  if (bothGoaliesMissing) {
    const maxMl = Math.max(Math.abs(game.mlHome ?? 0), Math.abs(game.mlAway ?? 0));
    if (maxMl > 300) {
      hardPass = true;
      hardPassReason = "missing_goalie_data_with_extreme_line";
    }
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

  // Re-orient Polymarket (home-keyed from the adapter) to the pick side.
  const rawPoly = game._polymarketData ?? { found: false, pct: null };
  let orientedPoly: PolymarketData = rawPoly;
  if (rawPoly.found && rawPoly.pct != null && pickSide === "away") {
    orientedPoly = { ...rawPoly, pct: Math.round((100 - rawPoly.pct) * 10) / 10 };
  }
  const polyPct = orientedPoly.found ? (orientedPoly.pct ?? null) : null;

  const confidence = computeConfidence(pickEdge, model, pickSide);

  const tier: Verdict = assignTier({
    edgePp: pickEdge,
    confidence,
    polyPct,
    hardPass,
    oddsAmerican: pickMl,
    winProb: pickWp,
  });

  // EEA flat-unit sizing (SPEC §4): conviction units → juice penalty → stake.
  let verdictTier = tier;
  const baseUnits = hardPass ? 0 : convictionUnits(verdictTier);
  const { units: juicedUnits, halfCut } = applyJuicePenalty(baseUnits, pickMl);
  let units = juicedUnits;
  let stakeDollars = unitsToStake(units, bankroll);

  // Alignment signal (SPEC §8): raw edge magnitude — confirming upgrade signal.
  const alignmentSignalRaw = pickEdge !== null ? Math.abs(round1(pickEdge)) : null;

  // Phantom-edge detector (SPEC §1, P0). Runs after tier: a missing-data pricing
  // artifact forces PASS / 0 units.
  let phantomEdge = false;
  if (detectPhantomEdge(model.modelNotes)) {
    phantomEdge = true;
    verdictTier = "PASS";
    units = 0;
    stakeDollars = 0;
    if (!model.modelNotes.includes(PHANTOM_NOTE)) model.modelNotes.unshift(PHANTOM_NOTE);
  }

  const qualifies = verdictTier !== "PASS" && !hardPass;
  const verdict: "PLAY" | "PASS" = qualifies ? "PLAY" : "PASS";

  const hardPassOrPhantom = hardPass || phantomEdge;
  const markets = buildMarkets(game, model, pickSide, pickTeam, pickEdge, pickMl, pickBook, verdictTier, units, hardPassOrPhantom);

  return {
    sport: "nhl",
    gameStartIso: game.gameStartIso ?? null,
    gameId: game.gameId,
    gameDate: game.gameDate,
    gameTimeEt: game.gameTimeEt,
    venue: game.venue,
    matchup: `${game.awayTeamFull} @ ${game.homeTeamFull}`,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeTeamFull: game.homeTeamFull,
    awayTeamFull: game.awayTeamFull,
    homePitcher: game.homeGoalieName ?? undefined,
    awayPitcher: game.awayGoalieName ?? undefined,
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
    units,
    kellyStakeDollars: stakeDollars,
    kellyCapped: false,
    halfCut,
    phantomEdge,
    trimmed: false,
    subSampleWarning: false,
    subSampleDetails: null,
    alignmentSignalRaw,
    topPlay: false,
    verdict,
    verdictTier,
    qualifies,
    trapSignal: false,
    trapGapPp: null,
    eliteFadeApplied: false,
    dataQualityTier: model.dataQualityTier,
    hardPassReason,
    isSparseModel: false,
    projHomeScore: model.projHomeGoals,
    projAwayScore: model.projAwayGoals,
    expectedTotal: model.expectedTotalGoals,
    homeMl: game.mlHome ?? null,
    awayMl: game.mlAway ?? null,
    openHomeMl: null,
    openAwayMl: null,
    homeFairProb: homeFair,
    awayFairProb: awayFair,
    homeWinProb: model.homeWinProb,
    awayWinProb: model.awayWinProb,
    // Populate homeSp/awaySp with goalie data so the UI and API consumers have
    // consistent goalie stats. Uses pitcher field for name, era field for GAA,
    // and adds svPct as an extension field.
    homeSp: game._homeGoalie
      ? {
          available: game._homeGoalie.available,
          pitcher: game._homeGoalie.goalie ?? undefined,
          era: game._homeGoalie.gaa ?? null,
          svPct: game._homeGoalie.svPct ?? null,
        }
      : {},
    awaySp: game._awayGoalie
      ? {
          available: game._awayGoalie.available,
          pitcher: game._awayGoalie.goalie ?? undefined,
          era: game._awayGoalie.gaa ?? null,
          svPct: game._awayGoalie.svPct ?? null,
        }
      : {},
    // Dedicated goalie fields for NHL cards in the UI
    homeGoalie: game._homeGoalie
      ? {
          available: game._homeGoalie.available,
          name: game._homeGoalie.goalie ?? null,
          svPct: game._homeGoalie.svPct ?? null,
          gaa: game._homeGoalie.gaa ?? null,
          gp: game._homeGoalie.gp ?? null,
        }
      : null,
    awayGoalie: game._awayGoalie
      ? {
          available: game._awayGoalie.available,
          name: game._awayGoalie.goalie ?? null,
          svPct: game._awayGoalie.svPct ?? null,
          gaa: game._awayGoalie.gaa ?? null,
          gp: game._awayGoalie.gp ?? null,
        }
      : null,
    polymarket: orientedPoly,
    // Orient public/sharp percentages to the pick side (home-keyed by convention).
    publicPct: pickSide === "away" && game._publicPct != null
      ? Math.round((100 - game._publicPct) * 10) / 10
      : (game._publicPct ?? null),
    sharpPct: pickSide === "away" && game._sharpPct != null
      ? Math.round((100 - game._sharpPct) * 10) / 10
      : (game._sharpPct ?? null),
    modelNotes: model.modelNotes,
  };
}

function buildMarkets(
  game: NhlGameInput,
  model: NhlModelResult,
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

  const margin = model.projHomeGoals - model.projAwayGoals;

  let spread: Market = emptyMarket();
  if (game.spreadHomePrice != null && game.spreadAwayPrice != null) {
    const homeLine = game.spreadHomeLine ?? -1.5;
    const homeCoverProb = logistic((margin + homeLine) / PUCK_MARGIN_SCALE);
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
    const overProb = logistic((model.expectedTotalGoals - game.totalLine) / TOTAL_SCALE);
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
  SNIPER: 0, EDGE: 1, RECON: 2, PASS: 3,
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
        p.verdictTier = "PASS";
        p.verdict = "PASS";
        p.qualifies = false;
        p.units = 0;
        p.kellyStakeDollars = 0;
      } else count++;
    }
  }
  return sorted;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
