// Soccer picks engine — 3-way market (Home/Draw/Away), EEA flat-unit sizing,
// draw cap at RECON tier, friendly cap at RECON, WC matchday-1 cap at RECON,
// phantom-edge detection on league-fallback notes.

import { assignTier } from "../../core/tier";
import { convictionUnits, applyJuicePenalty, unitsToStake } from "../../core/sizing";
import { detectPhantomEdge, PHANTOM_NOTE } from "../../core/phantom";
import { buildTwoWayMarket } from "../../core/markets";
import { emptyMarket, type Market, type MarketSet, type Side, type Verdict } from "../../core/types";
import type { BuiltPick } from "../mlb/picksEngine";
import type { SoccerModelResult } from "./model";

export const BANKROLL_USD = 35800;
export const MAX_PICKS_PER_DAY = 6;
const GOAL_MARGIN_SCALE = 1.8;
const TOTAL_SCALE = 2.2;

export interface SoccerGameInput {
  gameId: string;
  gameDate: string;
  gameTimeEt: string;
  venue: string;
  homeTeam: string;   // tri-code
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  leagueName: string | null;
  leagueId: number | null;
  isFriendly: boolean;
  isWorldCupMatchday1?: boolean;
  homeForm?: string | null;   // "WWLDW"
  awayForm?: string | null;
  mlHome?: number | null;
  mlDraw?: number | null;
  mlAway?: number | null;
  mlHomeBook?: string | null;
  mlAwayBook?: string | null;
  homeFairProb?: number | null;
  drawFairProb?: number | null;
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
  openHomeMl?: number | null;
  openAwayMl?: number | null;
  _publicPct?: number | null;
  _sharpPct?: number | null;
  _polymarketData?: { found: boolean; pct?: number | null; reason?: string };
}

// Soccer-specific pick extends BuiltPick with extra fields
export interface SoccerPick extends BuiltPick {
  sport: "soccer";
  leagueName: string | null;
  leagueId: number | null;
  leaguePrefix: string;         // "🏆 World Cup ·" or "Brasileirão ·"
  isFriendly: boolean;
  isDraw: boolean;               // true when the pick is on the Draw outcome
  homeForm: string | null;
  awayForm: string | null;
  homeWinProb: number | null;
  awayWinProb: number | null;
  drawProb: number | null;
  mlDraw: number | null;
  fairDrawMl: number | null;
  // Convenience alias fields for API consumers
  teamHome: string;
  teamAway: string;
  league: string | null;
  tier: Verdict;
}

type SoccerPickSide = Side | "draw";

function computeLeaguePrefix(leagueName: string | null, isFriendly: boolean): string {
  if (!leagueName) return isFriendly ? "Friendly ·" : "Soccer ·";
  const l = leagueName.toLowerCase();
  if (l.includes("world cup")) return "🏆 World Cup ·";
  if (l.includes("club world cup")) return "🏆 Club WC ·";
  if (l.includes("premier league") || l.includes("epl")) return "EPL ·";
  if (l.includes("brazil") || l.includes("brasileir")) return "Brasileirão ·";
  if (l.includes("la liga")) return "La Liga ·";
  if (l.includes("bundesliga")) return "Bundesliga ·";
  if (l.includes("serie a")) return "Serie A ·";
  if (l.includes("champions league")) return "UCL ·";
  return `${leagueName} ·`;
}

// Soccer confidence: base 30 + edge component + data quality + market agreement.
function computeConfidence(
  edgePp: number | null,
  model: SoccerModelResult,
  pickSide: SoccerPickSide,
  isFriendly: boolean,
): number {
  let score = 30.0;
  score += Math.min(25.0, Math.abs(edgePp ?? 0) * 5.0);

  // data completeness bonus
  if (!model.isSparseModel) score += 8;
  if (model.shrinkageApplied) score += 5;

  // side-specific form bonus
  if (pickSide === "home" && model.homeWinProb >= 0.45) score += 3;
  if (pickSide === "away" && model.awayWinProb >= 0.45) score += 3;

  // friendly penalty
  if (isFriendly) score -= 10;

  return Math.min(99, Math.max(0, Math.round(score)));
}

function fmtAmerican(ml: number | null): string {
  if (ml === null) return "";
  return ml > 0 ? `+${ml}` : `${ml}`;
}
function fmtLine(line: number | null): string {
  if (line === null) return "";
  return line > 0 ? `+${line}` : `${line}`;
}
function round2(x: number) { return Math.round(x * 100) / 100; }

function buildSoccerMarkets(
  game: SoccerGameInput,
  model: SoccerModelResult,
  pickSide: SoccerPickSide,
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
    pick: pickMl !== null
      ? (pickSide === "draw"
          ? `Draw ${fmtAmerican(pickMl)}`
          : `${pickTeam} ML ${fmtAmerican(pickMl)}`)
      : null,
    line: null,
    priceAmerican: pickMl,
    fairLine: pickSide === "home" ? model.fairHomeMl
            : pickSide === "away" ? model.fairAwayMl
            : model.fairDrawMl,
    edgePp: pickEdge !== null ? round2(pickEdge) : null,
    tier: hardPass ? "PASS" : pickTier,
    units: hardPass ? 0 : pickUnits,
    side: pickSide,
    book: pickBook,
  };

  if (hardPass) {
    return { ml: { ...ml, tier: "PASS", units: 0 }, spread: emptyMarket(), total: emptyMarket() };
  }

  const margin = model.projHomeGoals - model.projAwayGoals;

  // Spread (Asian handicap)
  let spread: Market = emptyMarket();
  if (game.spreadHomePrice != null && game.spreadAwayPrice != null) {
    const homeLine = game.spreadHomeLine ?? -0.5;
    const homeCoverProb = logistic((margin + homeLine) / GOAL_MARGIN_SCALE);
    spread = buildTwoWayMarket(
      {
        aLabel: "home",
        aLine: homeLine,
        aPrice: game.spreadHomePrice,
        bLabel: "away",
        bLine: game.spreadAwayLine ?? -homeLine,
        bPrice: game.spreadAwayPrice,
        book: game.spreadBook ?? null,
      },
      homeCoverProb,
      BANKROLL_USD,
      (side, line, price) => {
        const team = side === "a" ? game.homeTeam : game.awayTeam;
        return `${team} AH ${fmtLine(line)} (${fmtAmerican(price)})`;
      },
    );
  }

  // Total (O/U Goals)
  let total: Market = emptyMarket();
  if (game.totalOverPrice != null && game.totalUnderPrice != null && game.totalLine != null) {
    const overProb = logistic((model.expectedTotalGoals - game.totalLine) / TOTAL_SCALE);
    total = buildTwoWayMarket(
      {
        aLabel: "over",
        aLine: game.totalLine,
        aPrice: game.totalOverPrice,
        bLabel: "under",
        bLine: game.totalLine,
        bPrice: game.totalUnderPrice,
        book: game.totalBook ?? null,
      },
      overProb,
      BANKROLL_USD,
      (side, line, price) => `${side === "a" ? "Over" : "Under"} ${line} Goals (${fmtAmerican(price)})`,
    );
  }

  return { ml, spread, total };
}

function logistic(x: number): number { return 1 / (1 + Math.exp(-x)); }

export function buildPick(
  game: SoccerGameInput,
  model: SoccerModelResult,
  bankroll = BANKROLL_USD,
): SoccerPick {
  const homeFull = game.homeTeamFull;
  const awayFull = game.awayTeamFull;

  // Hard pass gate
  let hardPass = Boolean(model.hardPassReason) || !model.canModel;
  let hardPassReason = model.hardPassReason ?? null;
  if (!model.canModel) {
    hardPass = true;
    hardPassReason = model.reason ?? "model_skipped";
  }

  // Compute edges for all three outcomes
  const homeFairMkt = game.homeFairProb ?? null;
  const awayFairMkt = game.awayFairProb ?? null;
  const drawFairMkt = game.drawFairProb ?? null;

  const homeEdge = model.homeWinProb !== null && homeFairMkt !== null
    ? (model.homeWinProb - homeFairMkt) * 100 : null;
  const awayEdge = model.awayWinProb !== null && awayFairMkt !== null
    ? (model.awayWinProb - awayFairMkt) * 100 : null;
  const drawEdge = model.drawProb !== null && drawFairMkt !== null
    ? (model.drawProb - drawFairMkt) * 100 : null;

  const hVal = homeEdge ?? -999;
  const aVal = awayEdge ?? -999;
  const dVal = drawEdge ?? -999;

  // Pick the best edge side
  let pickSide: SoccerPickSide;
  let pickTeam: string;
  let pickTeamFull: string;
  let pickEdge: number | null;
  let pickWp: number | null;
  let pickMl: number | null;
  let pickBook: string | null;
  let pickFairMkt: number | null;

  if (hVal >= aVal && hVal >= dVal) {
    pickSide = "home";
    pickTeam = game.homeTeam;
    pickTeamFull = homeFull;
    pickEdge = homeEdge;
    pickWp = model.homeWinProb;
    pickMl = game.mlHome ?? null;
    pickBook = game.mlHomeBook ?? null;
    pickFairMkt = homeFairMkt;
  } else if (aVal >= hVal && aVal >= dVal) {
    pickSide = "away";
    pickTeam = game.awayTeam;
    pickTeamFull = awayFull;
    pickEdge = awayEdge;
    pickWp = model.awayWinProb;
    pickMl = game.mlAway ?? null;
    pickBook = game.mlAwayBook ?? null;
    pickFairMkt = awayFairMkt;
  } else {
    pickSide = "draw";
    pickTeam = "Draw";
    pickTeamFull = "Draw";
    pickEdge = drawEdge;
    pickWp = model.drawProb;
    pickMl = game.mlDraw ?? null;
    pickBook = game.mlHomeBook ?? null; // use any book label
    pickFairMkt = drawFairMkt;
  }

  const isDraw = pickSide === "draw";

  // EV
  const ev = pickWp !== null && pickMl !== null
    ? computeEv(pickWp, pickMl)
    : 0.0;

  const confidence = computeConfidence(pickEdge, model, pickSide, game.isFriendly);

  // Tier assignment — with soccer caps applied AFTER
  let tier = assignTier({
    edgePp: pickEdge,
    confidence,
    polyPct: game._polymarketData?.found ? (game._polymarketData.pct ?? null) : null,
    evPer100: ev,
    hardPass,
    trapCapped: model.trapSignal,
    oddsAmerican: pickMl,
    winProb: pickWp,
  });

  // Soccer caps (§6):
  // Draw bets → cap at RECON (no SNIPER/BONUS for draws)
  // Friendly → cap at RECON
  // WC group stage matchday 1 → cap at RECON
  const ABOVE_RECON: Verdict[] = ["BONUS", "SNIPER", "EDGE"];
  const isCapped = isDraw || game.isFriendly || game.isWorldCupMatchday1;
  if (isCapped && ABOVE_RECON.includes(tier as Verdict)) {
    tier = "RECON";
  }

  // Phantom-edge detector
  let phantomEdge = false;
  if (detectPhantomEdge(model.modelNotes)) {
    phantomEdge = true;
    tier = "PASS";
    if (!model.modelNotes.includes(PHANTOM_NOTE)) model.modelNotes.unshift(PHANTOM_NOTE);
  }

  // Sizing
  let verdictTier = tier as Verdict;
  const baseUnits = hardPass ? 0 : convictionUnits(verdictTier);
  const { units: juicedUnits, halfCut } = applyJuicePenalty(baseUnits, pickMl);
  let units = juicedUnits;
  let stakeDollars = unitsToStake(units, bankroll);

  if (phantomEdge) { units = 0; stakeDollars = 0; verdictTier = "PASS"; }

  const qualifies = ["BONUS", "SNIPER", "EDGE", "RECON", "VALUE"].includes(verdictTier);
  let verdict: "PLAY" | "PASS" | "LEAN";
  if (hardPass || verdictTier === "PASS") verdict = "PASS";
  else if (verdictTier === "LEAN") verdict = "LEAN";
  else if (qualifies) verdict = "PLAY";
  else verdict = "PASS";

  const leaguePrefix = computeLeaguePrefix(game.leagueName, game.isFriendly);

  // Orient public/sharp to pick side
  const rawPublicPct = game._publicPct ?? null;
  const rawSharpPct = game._sharpPct ?? null;
  const resolvedPublicPct = pickSide === "away" && rawPublicPct !== null
    ? Math.round((100 - rawPublicPct) * 10) / 10 : rawPublicPct;
  const resolvedSharpPct = pickSide === "away" && rawSharpPct !== null
    ? Math.round((100 - rawSharpPct) * 10) / 10 : rawSharpPct;

  // Polymarket
  const rawPoly = game._polymarketData ?? { found: false, pct: null };
  let orientedPoly = rawPoly;
  if (rawPoly.found && rawPoly.pct != null && pickSide === "away") {
    orientedPoly = { ...rawPoly, pct: Math.round((100 - rawPoly.pct) * 10) / 10 };
  }

  const alignmentSignalRaw = model.trapGapPp ?? (pickEdge !== null ? Math.abs(round2(pickEdge)) : null);

  const markets = buildSoccerMarkets(
    game, model, pickSide, pickTeam, pickEdge, pickMl, pickBook,
    verdictTier, units, hardPass || phantomEdge,
  );

  // topPlay flag
  const topPlay = !phantomEdge && !hardPass && confidence >= 80 && (pickEdge ?? 0) >= 8 && !isDraw;

  return {
    sport: "soccer",
    gameId: game.gameId,
    gameDate: game.gameDate,
    gameTimeEt: game.gameTimeEt,
    venue: game.venue,
    matchup: `${awayFull} @ ${homeFull}`,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeTeamFull: homeFull,
    awayTeamFull: awayFull,
    // Convenience alias fields consumed by the curl verifier and UI renderers
    teamHome: homeFull,
    teamAway: awayFull,
    league: game.leagueName,
    homePitcher: undefined,
    awayPitcher: undefined,
    pickSide: pickSide === "draw" ? "home" : pickSide, // BuiltPick.pickSide is 'home'|'away'
    pickTeam,
    pickTeamFull,
    pickType: "ML",
    markets,
    pickMl,
    pickBook,
    pickWinProb: pickWp,
    pickImpliedProb: pickFairMkt,
    fairMl: pickSide === "home" ? model.fairHomeMl
          : pickSide === "away" ? model.fairAwayMl
          : model.fairDrawMl,
    edgePp: pickEdge !== null ? round2(pickEdge) : null,
    evPer100: ev,
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
    topPlay,
    verdict,
    verdictTier,
    tier: verdictTier,   // alias so API consumers that read 'tier' get the verdict tier
    qualifies,
    trapSignal: model.trapSignal,
    trapGapPp: model.trapGapPp,
    eliteFadeApplied: false,
    dataQualityTier: model.dataQualityTier,
    hardPassReason,
    isSparseModel: model.isSparseModel,
    projHomeScore: model.projHomeGoals,
    projAwayScore: model.projAwayGoals,
    expectedTotal: model.expectedTotalGoals,
    homeMl: game.mlHome ?? null,
    awayMl: game.mlAway ?? null,
    openHomeMl: game.openHomeMl ?? null,
    openAwayMl: game.openAwayMl ?? null,
    homeFairProb: homeFairMkt,
    awayFairProb: awayFairMkt,
    homeWinProb: model.homeWinProb,
    awayWinProb: model.awayWinProb,
    homeSp: {},
    awaySp: {},
    polymarket: orientedPoly,
    publicPct: resolvedPublicPct,
    sharpPct: resolvedSharpPct,
    modelNotes: model.modelNotes,
    // Soccer-specific
    leagueName: game.leagueName,
    leagueId: game.leagueId,
    leaguePrefix,
    isFriendly: game.isFriendly,
    isDraw,
    homeForm: game.homeForm ?? null,
    awayForm: game.awayForm ?? null,
    drawProb: model.drawProb,
    mlDraw: game.mlDraw ?? null,
    fairDrawMl: model.fairDrawMl,
  };
}

function computeEv(modelProb: number, americanOdds: number, stake = 100.0): number {
  const q = 1.0 - modelProb;
  const profit = americanOdds > 0
    ? stake * (americanOdds / 100.0)
    : stake * (100.0 / Math.abs(americanOdds));
  return Math.round((modelProb * profit - q * stake) * 100) / 100;
}

const TIER_RANK: Record<Verdict, number> = {
  BONUS: 0, SNIPER: 1, EDGE: 2, RECON: 3, VALUE: 4, LEAN: 5, PASS: 6,
};

export function applyDailyCap(picks: SoccerPick[], maxPicks = MAX_PICKS_PER_DAY): SoccerPick[] {
  const sorted = [...picks].sort((a, b) => {
    const r = TIER_RANK[a.verdictTier] - TIER_RANK[b.verdictTier];
    if (r !== 0) return r;
    return (b.edgePp ?? -999) - (a.edgePp ?? -999);
  });
  let actionableCount = 0;
  for (const p of sorted) {
    if (p.qualifies) {
      if (actionableCount >= maxPicks) {
        (p as SoccerPick & { verdictTier: Verdict }).verdictTier = "LEAN";
        p.verdict = "LEAN";
        p.qualifies = false;
        p.units = 0;
        p.kellyStakeDollars = 0;
      } else {
        actionableCount++;
      }
    }
  }
  return sorted;
}
