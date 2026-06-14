// Picks engine — ported from sports-engine sports/mlb/picks_engine.py.
// Confidence (7-component), Kelly sizing, verdict tier, daily 6-pick cap.

import { assignTier, downgradeTier, evaluateHardGates, isChalkierThanSniperCap, chalkCapReason } from "../../core/tier";
import { convictionUnits, applyJuicePenalty, unitsToStake, computeUnit } from "../../core/sizing";
import { taperBigDogStake, capEvPer100, pickRankScore } from "../units";
import { detectPhantomEdge, PHANTOM_NOTE } from "../../core/phantom";
import { buildTwoWayMarket } from "../../core/markets";
import type { Verdict, Side, Market, MarketSet } from "../../core/types";
import { emptyMarket } from "../../core/types";
import type { ModelResult } from "./model";
import { SOLID_IP_MIN, type PitcherStats } from "./pitchers";
import type { TeamOffense } from "./ratings";
import type { OddsEvent } from "../../adapters/oddsApi";
import {
  movementForPick,
  sharpConfidenceDelta,
  NEUTRAL_MOVEMENT,
  type SharpSignal,
} from "../../adapters/lineMovement";
import {
  lineupConfidenceDelta,
  lineupForcesDowngrade,
  PENDING_LINEUP,
  type LineupResult,
  type LineupStatus,
} from "./lineups";
import {
  recentFormConfidenceDelta,
  NEUTRAL_FORM,
  type RecentForm,
} from "./recentForm";

export const ELITE_FADE_PP = 12.0;
export const MAX_PICKS_PER_DAY = 3; // v6.7: 4 → 3 (props absorb volume; tighten game-line surface)
// v6.7: as prop volume comes online, game lines must clear a higher bar. Any
// actionable game-line pick under this edge is demoted to PASS regardless of
// tier. This is a game-line-only floor — it does NOT touch the shared tier
// constant TIER_RECON_EDGE (2.5), which props and the tier ladder still use.
export const GAME_LINE_RECON_FLOOR = 4.0;
// June reset (EEA operating rules). Overridable via BANKROLL_USD env at the route.
export const BANKROLL_USD = 25000;

export interface GameInput {
  gameId: string;
  gamePk?: string | null; // MLB Stats API gamePk (for umpire/lineup lookups)
  gameDate: string;
  gameTimeEt: string;
  gameStartIso?: string | null; // actual game start (ISO) — drives the CLV lock window
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
  spreadHomeLine?: number | null;
  spreadHomePrice?: number | null;
  spreadAwayLine?: number | null;
  spreadAwayPrice?: number | null;
  spreadBook?: string | null;
  totalLine?: number | null;
  totalOverPrice?: number | null;
  totalUnderPrice?: number | null;
  totalBook?: string | null;
  // Pre-computed public/sharp consensus (set by data.ts, optional)
  _publicPct?: number | null;
  _sharpPct?: number | null;
  _polymarketData?: PolymarketData;
  // Raw Odds API event, retained so the line-movement signal can be derived per
  // pick side after the pick is chosen (set by data.ts; undefined on demo).
  _oddsEvent?: OddsEvent | null;
  // Per-side lineup status, resolved in the slate after the pick side is known.
  _lineupHome?: LineupResult | null;
  _lineupAway?: LineupResult | null;
  // Per-side recent-form splits (last-7 / last-14), resolved in the slate.
  _recentFormHome?: RecentForm | null;
  _recentFormAway?: RecentForm | null;
}

// CLV payload sent to the client. null on the BuiltPick until the lock worker
// captures the closing line.
export interface ClvBadge {
  points: number;
  percent: number;
  status: "open" | "locked" | "final";
  postedOdds: number;
  closingOdds: number | null;
  closingSource?: string;
}

export interface PolymarketData {
  found: boolean;
  pct?: number | null; // 0-100 for pick side
  reason?: string;     // why not found
}

export interface SpStats {
  available?: boolean;
  pitcher?: string;
  era?: number | null;
  fip?: number | null;
  ip?: number | null;
  whip?: number | null;
}

export interface BuiltPick {
  sport: string; // 'mlb' | 'nhl' | 'nba'
  gameId: string;
  gameDate: string;
  gameTimeEt: string;
  gameStartIso?: string | null;
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
  markets: MarketSet;
  pickMl: number | null;
  pickBook: string | null;
  pickWinProb: number | null;
  pickImpliedProb: number | null;
  fairMl: number | null;
  edgePp: number | null;
  evPer100: number;
  evPer100Raw: number;
  evCapped: boolean;
  confidence: number;
  units: number;
  kellyStakeDollars: number;
  kellyCapped: boolean;
  // EEA sizing + signal fields (SPEC v2.5)
  halfCut: boolean;
  phantomEdge: boolean;
  trimmed: boolean;
  subSampleWarning: boolean;
  subSampleDetails: string | null;
  alignmentSignalRaw: number | null;
  topPlay: boolean;
  verdict: "PLAY" | "PASS";
  verdictTier: Verdict;
  qualifies: boolean;
  trapSignal: boolean;
  trapGapPp: number | null;
  eliteFadeApplied: boolean;
  dataQualityTier: string;
  hardPassReason: string | null;
  // v6.6: which hard PASS gate (if any) forced this pick to PASS — surfaced on
  // the card + API for audit. null when no gate fired.
  passReason: string | null;
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
  homeSp: SpStats & Record<string, unknown>;
  awaySp: SpStats & Record<string, unknown>;
  // NHL-only goalie fields (undefined on MLB/NBA picks)
  homeGoalie?: { available: boolean; name: string | null; svPct: number | null; gaa: number | null; gp: number | null } | null;
  awayGoalie?: { available: boolean; name: string | null; svPct: number | null; gaa: number | null; gp: number | null } | null;
  polymarket: PolymarketData;
  publicPct: number | null;  // avg implied prob across soft/public books (0-100)
  sharpPct: number | null;   // implied prob from sharp books (0-100)
  umpireName?: string | null;   // assigned HP umpire (MLB), null when unknown
  umpireRunAdj?: number;        // per-game run adjustment from umpire profile
  // Line movement + Pinnacle oracle (set when an Odds API event is available)
  openingLine?: number | null;  // pick-side American odds at first capture
  currentLine?: number | null;  // pick-side American odds now
  clvLive?: number | null;      // currentLine − openingLine, in cents (signed)
  sharpSignal?: SharpSignal;    // Pinnacle vs pick side
  steam?: boolean;              // a fast line move inside the steam window
  lineupStatus?: LineupStatus;  // confirmed / pending / star_out / star_questionable
  lineupMissingStar?: string | null; // the absent star, when status is star_out
  modelNotes: string[];
  // Graded-book status, attached when a slate is served (undefined until the
  // pick is persisted; "pending" once in the book). Drives the colored cards.
  gradeStatus?: "pending" | "in_progress" | "final";
  gradeResult?: "W" | "L" | "P" | null;
  gradePl?: number | null;
  clvPct?: number | null;
  // Closing Line Value — null until the lock worker captures the close. status
  // 'open' before lock, 'locked' once captured, 'final' after the game ends.
  clv?: ClvBadge | null;
  liveAwayScore?: number | null;
  liveHomeScore?: number | null;
  liveStatusDetail?: string | null;
  finalAwayScore?: number | null;
  finalHomeScore?: number | null;
  // Bet lock-in: true once the user confirmed the bet. lockedTier/Stake/Odds are
  // the frozen values the card must display (greyed-out, no edit controls).
  locked?: boolean;
  lockedAt?: string | null;
  lockedTier?: string | null;
  lockedStake?: number | null;
  lockedOdds?: number | null;
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

// Build the ML / spread / total market trio for a card. ML reuses the engine's
// devigged fair line; spread (run-line) and total derive model cover/over
// probabilities from the projected scores.
function buildMlbMarkets(
  game: GameInput,
  model: ModelResult,
  pickSide: Side,
  pickTeam: string,
  pickEdge: number | null,
  pickMl: number | null,
  pickBook: string | null,
  pickTier: Verdict,
  pickUnits: number,
  hardPass: boolean,
): MarketSet {
  // ── ML: reuse the headline pick we already computed.
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

  if (hardPass) {
    return { ml: { ...ml, tier: "PASS", units: 0 }, spread: emptyMarket(), total: emptyMarket() };
  }

  const margin = model.projHomeScore - model.projAwayScore; // home - away

  // ── Spread (run-line ±1.5). Model prob the home side covers -1.5 / +1.5.
  let spread: Market = emptyMarket();
  if (game.spreadHomePrice != null && game.spreadAwayPrice != null) {
    const homeLine = game.spreadHomeLine ?? -1.5;
    // P(home margin > -homeLine). For home -1.5 → P(margin > 1.5).
    const homeCoverProb = logistic((margin + homeLine) / RUN_MARGIN_SCALE);
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
        return `${team} ${fmtLine(line)} (${fmtAmerican(price)})`;
      },
    );
  }

  // ── Total (over/under). Model prob the game goes over the posted line.
  let total: Market = emptyMarket();
  if (game.totalOverPrice != null && game.totalUnderPrice != null && game.totalLine != null) {
    const overProb = logistic((model.expectedTotalRuns - game.totalLine) / TOTAL_SCALE);
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
      (side, line, price) => `${side === "a" ? "Over" : "Under"} ${line} (${fmtAmerican(price)})`,
    );
  }

  return { ml, spread, total };
}

export function buildPick(
  game: GameInput,
  model: ModelResult,
  bankroll = BANKROLL_USD,
  polymarketData?: PolymarketData,
  publicPct: number | null = null,
  sharpPct: number | null = null,
): BuiltPick {
  // Allow callers to pre-attach data via game fields (simpler threading).
  // Note: _publicPct / _sharpPct from data.ts are home-side probabilities.
  // We'll orient them to the pick side after we determine pickSide below.
  const resolvedPoly = polymarketData ?? game._polymarketData;
  const rawPublicPct = publicPct ?? game._publicPct ?? null;
  const rawSharpPct  = sharpPct  ?? game._sharpPct  ?? null;
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

  const evRaw = pickWp !== null && pickMl !== null ? computeEv(pickWp, pickMl) : 0.0;
  // v6.6: cap the displayed EV at +30/$100; anything higher is a tail artifact.
  // Confidence + the EV ceiling tier-gate use the RAW value (we don't want the
  // cap to hide a calibration blow-up); the card shows the capped value.
  const { evPer100: ev, evPer100Raw, evCapped } = capEvPer100(evRaw);

  // Orient public/sharp pcts to the pick side.
  // data.ts computes them for the home side; away picks need 100 - x.
  const resolvedPublicPct = pickSide === "away" && rawPublicPct !== null
    ? Math.round((100 - rawPublicPct) * 10) / 10
    : rawPublicPct;
  const resolvedSharpPct = pickSide === "away" && rawSharpPct !== null
    ? Math.round((100 - rawSharpPct) * 10) / 10
    : rawSharpPct;

  // Re-orient polymarket pct to the pick side.
  // The lookup in data.ts fetches for the home side; if we're picking away
  // we invert it (pct → 100 - pct) so the bar represents the pick team.
  let orientedPoly = resolvedPoly;
  if (resolvedPoly?.found && resolvedPoly.pct != null && pickSide === "away") {
    orientedPoly = { ...resolvedPoly, pct: Math.round((100 - resolvedPoly.pct) * 10) / 10 };
  }

  const baseConfidence = computeConfidence({
    edgePp: pickEdge,
    evPer100: evRaw,
    isSparseModel: model.isSparseModel,
    eliteFadeApplied,
    pickSide,
    homeSp,
    awaySp,
    homeOff,
    awayOff,
    pickWinProb: pickWp,
    polymarket: orientedPoly,
  });

  // Line movement + Pinnacle oracle. Best-effort: NEUTRAL when no Odds API event
  // / history is available (e.g. demo slate). Pinnacle confirming the pick side
  // nudges confidence up; fading it cuts confidence.
  const movement = game._oddsEvent
    ? movementForPick(game._oddsEvent, pickSide, pickFairMkt)
    : NEUTRAL_MOVEMENT;

  // Lineup confirmation: a star out on our side cuts confidence and downgrades
  // the tier one rung; a confirmed lineup with our stars in is a small bump.
  const lineup: LineupResult =
    (pickSide === "home" ? game._lineupHome : game._lineupAway) ?? PENDING_LINEUP;

  // Recent-form split for the backed side: hot last-7 bats nudge confidence up,
  // cold bats down. NEUTRAL/missing form is a no-op.
  const recentForm: RecentForm =
    (pickSide === "home" ? game._recentFormHome : game._recentFormAway) ?? NEUTRAL_FORM;

  // Umpire-aligned bonus (MLB): a meaningful assigned-plate-umpire profile the
  // model already folded into the run line is a small confirmation. Neutral or
  // missing umpire data (|runAdj| ≤ 0.15) is a no-op.
  const umpireAlignedBonus = Math.abs(model.umpireRunAdj ?? 0) > 0.15 ? 3 : 0;

  const confidence = Math.max(
    0,
    Math.min(
      99,
      baseConfidence +
        sharpConfidenceDelta(movement.sharpSignal) +
        lineupConfidenceDelta(lineup.status) +
        recentFormConfidenceDelta(recentForm) +
        umpireAlignedBonus,
    ),
  );

  const polyPct = orientedPoly?.found ? (orientedPoly.pct ?? null) : null;

  const tierInput = {
    edgePp: pickEdge,
    confidence,
    polyPct,
    evPer100: evRaw,
    hardPass,
    trapCapped: model.trapSignal,
    oddsAmerican: pickMl,
    winProb: pickWp,
    trapSignal: model.trapSignal,
    trapGapPp: model.trapGapPp,
    dataQualityTier: model.dataQualityTier,
  };
  // v6.6 hard PASS gate audit string (trap / EV ceiling / max odds / wp floor).
  const hardGate = evaluateHardGates(tierInput);
  let passReason: string | null = hardGate.fired ? hardGate.reason : null;

  let tier = assignTier(tierInput);
  // v6.8.1: if this pick is chalkier than the SNIPER cap and it landed on PASS,
  // attribute the PASS to the chalk cap (persistPicks maps "chalk" → chalk_cap).
  // A chalk pick that still clears EDGE stays EDGE — no reason override.
  if (tier === "PASS" && !passReason && isChalkierThanSniperCap(pickMl)) {
    passReason = chalkCapReason(pickMl);
  }
  if (lineupForcesDowngrade(lineup.status) && tier !== "PASS") {
    tier = downgradeTier(tier);
  }
  // v6.6 gate C.E: never an EDGE/SNIPER on LOW-quality data — cap at RECON.
  if (
    (model.dataQualityTier ?? "").toUpperCase() === "LOW" &&
    (tier === "EDGE" || tier === "SNIPER")
  ) {
    tier = "RECON";
  }

  // EEA flat-unit sizing (SPEC §4): conviction units → juice penalty → stake.
  let verdictTier = tier;
  const baseUnits = hardPass ? 0 : convictionUnits(verdictTier);
  const { units: juicedUnits, halfCut } = applyJuicePenalty(baseUnits, pickMl);
  // v6.6 big-dog taper: shrink Kelly/conviction units as the price climbs; a
  // +1001-or-longer dog is tapered to 0 (and gated to PASS below). Applied
  // AFTER sizing, BEFORE the verdict is finalized.
  let units = pickMl !== null ? taperBigDogStake(juicedUnits, pickMl) : juicedUnits;
  if (units === 0 && juicedUnits > 0 && verdictTier !== "PASS") {
    // Taper zeroed the stake (price too long to play) — force PASS to match.
    verdictTier = "PASS";
    tier = "PASS";
    if (!passReason) passReason = `+${pickMl} exceeds max odds policy`;
  }
  let stakeDollars = unitsToStake(units, bankroll);

  // Sub-25 IP warning (SPEC §7): judgment-only flag, no auto tier/size change.
  const homeIp = numOrNull(homeSp.ip) ?? 0;
  const awayIp = numOrNull(awaySp.ip) ?? 0;
  const subFlags: string[] = [];
  if (homeIp > 0 && homeIp < SOLID_IP_MIN) subFlags.push(`${homeSp.pitcher ?? "home SP"} ${homeIp.toFixed(1)} IP`);
  if (awayIp > 0 && awayIp < SOLID_IP_MIN) subFlags.push(`${awaySp.pitcher ?? "away SP"} ${awayIp.toFixed(1)} IP`);
  const subSampleWarning = subFlags.length > 0;
  const subSampleDetails = subSampleWarning ? subFlags.join(" · ") : null;

  // Alignment signal (SPEC §8, Ken's locked answer): raw edge magnitude before
  // shrinkage. Distinct from the trap detector — raw ≥20pp is a confirming
  // upgrade signal, not a downgrade.
  const alignmentSignalRaw = model.trapGapPp ?? (pickEdge !== null ? Math.abs(round1(pickEdge)) : null);

  // Phantom-edge detector (SPEC §1, P0). Runs AFTER tier assignment: if any
  // model note signals a missing-data pricing artifact, force PASS / 0 units.
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

  // 6-signal TOP PLAY badge (SPEC §8) — computed separately from tier.
  const ourSp = pickSide === "home" ? homeSp : awaySp;
  const ourFip = numOrNull(ourSp.fip);
  const ourIp = pickSide === "home" ? homeIp : awayIp;
  const eliteOurSp = ourFip !== null && ourFip <= 3.5 && ourIp >= 80;
  const crossConfirmed =
    model.shrinkageApplied &&
    polyPct !== null &&
    polyPct >= 55 &&
    pickWp !== null &&
    pickWp >= 0.5;
  const topPlay =
    !phantomEdge &&
    !hardPass &&
    confidence >= 80 &&
    (pickEdge ?? 0) >= 8 &&
    (alignmentSignalRaw ?? 0) >= 20 &&
    eliteOurSp &&
    crossConfirmed &&
    pickMl !== null &&
    pickMl >= -110;

  const hardPassOrPhantom = hardPass || phantomEdge;
  const markets = buildMlbMarkets(
    game,
    model,
    pickSide,
    pickTeam,
    pickEdge,
    pickMl,
    pickBook,
    verdictTier,
    units,
    hardPassOrPhantom,
  );

  return {
    sport: "mlb",
    gameId: game.gameId,
    gameDate: game.gameDate,
    gameTimeEt: game.gameTimeEt,
    gameStartIso: game.gameStartIso ?? null,
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
    markets,
    pickMl,
    pickBook,
    pickWinProb: pickWp,
    pickImpliedProb: pickFairMkt,
    fairMl: pickSide === "home" ? model.fairHomeMl : model.fairAwayMl,
    edgePp: pickEdge !== null ? round2(pickEdge) : null,
    evPer100: ev,
    evPer100Raw,
    evCapped,
    confidence,
    units,
    kellyStakeDollars: stakeDollars,
    kellyCapped: false,
    halfCut,
    phantomEdge,
    trimmed: false,
    subSampleWarning,
    subSampleDetails,
    alignmentSignalRaw,
    topPlay,
    verdict,
    verdictTier,
    qualifies,
    trapSignal: model.trapSignal,
    trapGapPp: model.trapGapPp,
    eliteFadeApplied,
    dataQualityTier: model.dataQualityTier,
    hardPassReason,
    passReason,
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
    polymarket: orientedPoly ?? { found: false, pct: null },
    publicPct: resolvedPublicPct,
    sharpPct: resolvedSharpPct,
    umpireName: model.umpireName,
    umpireRunAdj: model.umpireRunAdj,
    openingLine: movement.openingLine,
    currentLine: movement.currentLine,
    clvLive: movement.clvCents,
    sharpSignal: movement.sharpSignal,
    steam: movement.steam,
    lineupStatus: lineup.status,
    lineupMissingStar: lineup.missingStar,
    modelNotes: model.modelNotes,
  };
}

// Daily cap: sort by edge desc (within tier rank), take the top N actionable
// plays; surplus actionable picks fall to PASS (not displayed in plays-only).
const TIER_RANK: Record<Verdict, number> = {
  SNIPER: 0,
  EDGE: 1,
  RECON: 2,
  PASS: 3,
};

export function applyDailyCap(picks: BuiltPick[], maxPicks = MAX_PICKS_PER_DAY): BuiltPick[] {
  // v6.6 ranking: tier rank first, then confidence × edge / sqrt(1+impliedProb)
  // so the best N spots survive the (now tighter) cap.
  const sorted = [...picks].sort((a, b) => {
    const r = TIER_RANK[a.verdictTier] - TIER_RANK[b.verdictTier];
    if (r !== 0) return r;
    return (
      pickRankScore(b.confidence, b.edgePp, b.pickImpliedProb) -
      pickRankScore(a.confidence, a.edgePp, a.pickImpliedProb)
    );
  });

  let actionableCount = 0;
  for (const p of sorted) {
    if (p.qualifies) {
      // v6.7 game-line RECON floor: demote thin edges before the cap counts them.
      if ((p.edgePp ?? 0) < GAME_LINE_RECON_FLOOR || actionableCount >= maxPicks) {
        p.verdictTier = "PASS";
        p.verdict = "PASS";
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

// Scale params for mapping projected run differentials → cover/over probability.
// Tuned so a 1-run edge on the line ≈ 56% and a 1.5-run total gap ≈ 60%.
const RUN_MARGIN_SCALE = 2.6;
const TOTAL_SCALE = 2.9;

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

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
