// Picks engine — ported from sports-engine sports/mlb/picks_engine.py.
// Confidence (7-component), Kelly sizing, verdict tier, daily 6-pick cap.

import { assignTier, downgradeTier, evaluateHardGates, isChalkierThanSniperCap, chalkCapReason } from "../../core/tier";
import { convictionUnits, applyJuicePenalty, unitsToStake, computeUnit } from "../../core/sizing";
import { taperBigDogStake, capEvPer100, pickRankScore } from "../units";
import { detectPhantomEdge, PHANTOM_NOTE } from "../../core/phantom";
import { buildTwoWayMarket } from "../../core/markets";
import type { Verdict, Side, Market, MarketSet } from "../../core/types";
import { emptyMarket } from "../../core/types";
import type { PickSignals } from "../../../shared/types/signals";
import { assembleSignals } from "../signals/assembleSignals";
import type { ModelResult } from "./model";
import { SOLID_IP_MIN, type PitcherStats } from "./pitchers";
import type { TeamOffense } from "./ratings";
import type { OddsEvent } from "../../adapters/oddsApi";
import { pickToDkLink } from "../../lib/dkLinks";
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
  // v6.10: sabermetric context pre-fetched by data.ts
  _homePitcherSaber?: import('./pitcherSabermetrics').PitcherSabermetrics | null;
  _awayPitcherSaber?: import('./pitcherSabermetrics').PitcherSabermetrics | null;
  _homeOffenseSaber?: import('./teamOffenseSaber').TeamOffenseSaber | null;
  _awayOffenseSaber?: import('./teamOffenseSaber').TeamOffenseSaber | null;
  _homeHandedness?: import('./handednessSplits').HandednessSplit | null;
  _awayHandedness?: import('./handednessSplits').HandednessSplit | null;
  // v6.10.1: false when MLB Stats API hasn't published probable starters yet.
  // Game is still built and surfaced, but auto-tiered PASS with a "Awaiting starters" badge.
  pitchersAnnounced?: boolean;
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
  // v6.10.1: false when probable starters were not published yet — game surfaces as PASS with badge
  pitchersAnnounced: boolean;
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
  // v6.9.0: five-source PickSignals, assembled at the serialization layer for the
  // SignalsBar UI. Additive + read-only — does NOT feed the tier engine.
  signals?: PickSignals;
  // v6.9.2: DraftKings one-tap deep-link. Present only on SNIPER picks; null otherwise.
  dk?: { selectionId: string | null; eventId: string; deepLink: string } | null;
  // v6.10.4: signal-stack depth — proximity-qualified signals closer to MODEL than MARKET.
  signalStack?: {
    count: number;
    supporting: string[];
    contradicting: string[];
  } | null;
  // v6.10: sabermetric composite win prob (internal — used by assembleSignals for saber signal)
  _saberWinProb?: number | null;
  // v6.10: pitcher and offense sabermetric edge fields (additive, null when unavailable)
  pitcherEdge?: {
    pickSideXFIP: number | null;
    oppSideXFIP: number | null;
    pickSideKBBPct: number | null;
    oppSideKBBPct: number | null;
    pickSideWHIP: number | null;
    oppSideWHIP: number | null;
  } | null;
  offenseEdge?: {
    pickSideWRCplus: number | null;
    oppSideWRCplus: number | null;
    handednessAdvantage: 'pick' | 'opp' | 'neutral';
  } | null;
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

// v6.10.4 — proximity-based signal-stack: a signal "supports MODEL" only if it
// sits meaningfully closer to MODEL than to MARKET (positionRatio >= 0.4).
// Replaces the v6.10.3 same-side test which counted SHARP/PRISM/PREDICT as
// supporting whenever they merely picked the same side as MODEL.
export function computeSignalStack(
  signals: PickSignals,
  pickSide: 'home' | 'away',
): {
  count: number;
  supporting: string[];
  contradicting: string[];
} {
  const modelProb = signals.model?.prob;
  const marketProb = signals.market?.prob;
  if (modelProb == null || marketProb == null) {
    return { count: 0, supporting: [], contradicting: [] };
  }

  // The MODEL-vs-MARKET gap. We measure how close each signal sits to MODEL vs MARKET.
  const modelMarketGap = Math.abs(modelProb - marketProb);
  if (modelMarketGap < 0.02) {
    // MODEL essentially matches MARKET → no edge, stack count is moot
    return { count: 0, supporting: [], contradicting: [] };
  }

  const candidates: Array<[string, import('../../../shared/types/signals').Signal | null | undefined]> = [
    ['sharp',   signals.sharp],
    ['prism',   signals.prism],
    ['predict', signals.predict],
    ['saber',   signals.saber],
  ];

  const supporting: string[] = [];
  const contradicting: string[] = [];

  for (const [name, sig] of candidates) {
    if (!sig || sig.prob == null) continue;

    // positionRatio = 0 → signal == MARKET; 1 → signal == MODEL.
    // We require >= 0.4 to count as supporting (genuinely closer to MODEL).
    const positionRatio = (sig.prob - marketProb) / (modelProb - marketProb);

    if (positionRatio >= 0.4) {
      supporting.push(name);
    } else if (positionRatio < -0.2) {
      // Signal is on the OPPOSITE side of MARKET from MODEL → contradicting
      contradicting.push(name);
    }
    // Signals between -0.2 and 0.4 are "neutral" (close to market, neither help nor hurt)
  }

  return { count: supporting.length, supporting, contradicting };
}

// v6.10.4 — adjust baseline units based on signal-stack depth.
// With the proximity-based stack test, stack >= 2 is genuinely rare and
// significant; stack=1 is the normal single-signal corroboration (not a demote).
// Called AFTER the baseline units from conviction/juice/taper pipeline.
export function signalStackUnitsAdjustment(
  baselineUnits: number,
  stackCount: number,
  contradictingCount: number,
): number {
  if (baselineUnits === 0) return 0; // PASS stays PASS

  // Contradicting signals are a HARD penalty
  if (contradictingCount >= 2) return Math.max(0, baselineUnits - 2); // 2+ signals against = severe demote
  if (contradictingCount === 1) return Math.max(0, baselineUnits - 1);

  // Stack ladder (v6.10.4): strict proximity test makes stack>=2 genuinely rare
  if (stackCount >= 3) return baselineUnits + 1; // 3+ corroborating signals: +1u
  if (stackCount === 2) return baselineUnits + 1; // 2 supporting (was: baseline) — now a +1 bonus
  if (stackCount === 1) return baselineUnits;     // single corroboration: baseline (was: -1u floor 1)
  if (stackCount === 0) return Math.max(0, baselineUnits - 1); // no corroboration: -1u floor 0

  return baselineUnits;
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

  // v6.10.1: TBD probable starters — surface the game as PASS with a badge instead
  // of silently dropping it. The slate rebuilds every request, so once MLB publishes
  // probables the card will re-tier automatically.
  const pitchersAnnounced = game.pitchersAnnounced !== false; // defaults true for back-compat
  if (!pitchersAnnounced) {
    hardPass = true;
    hardPassReason = hardPassReason ?? "tbd_pitcher";
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
  let taperedUnits = pickMl !== null ? taperBigDogStake(juicedUnits, pickMl) : juicedUnits;
  if (taperedUnits === 0 && juicedUnits > 0 && verdictTier !== "PASS") {
    // Taper zeroed the stake (price too long to play) — force PASS to match.
    verdictTier = "PASS";
    tier = "PASS";
    if (!passReason) passReason = `+${pickMl} exceeds max odds policy`;
  }

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
    if (!model.modelNotes.includes(PHANTOM_NOTE)) model.modelNotes.unshift(PHANTOM_NOTE);
  }

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

  // v6.10: Build pitcherEdge and offenseEdge sub-objects for the pick payload.
  // Orient by pick side: pickSide=home means we're backing the home team.
  const isHome = pickSide === "home";
  const pitcherEdgePayload = {
    pickSideXFIP:    isHome ? model.homeXFIP    : model.awayXFIP,
    oppSideXFIP:     isHome ? model.awayXFIP    : model.homeXFIP,
    pickSideKBBPct:  isHome ? model.homeKBBPct  : model.awayKBBPct,
    oppSideKBBPct:   isHome ? model.awayKBBPct  : model.homeKBBPct,
    pickSideWHIP:    isHome ? model.homeWHIP    : model.awayWHIP,
    oppSideWHIP:     isHome ? model.awayWHIP    : model.homeWHIP,
  };

  // Handedness advantage direction for the pick side.
  const pickHandAdj  = isHome ? model.homeHandednessAdj : model.awayHandednessAdj;
  const oppHandAdj   = isHome ? model.awayHandednessAdj : model.homeHandednessAdj;
  let handednessAdvantage: 'pick' | 'opp' | 'neutral' = 'neutral';
  if (pickHandAdj !== null && oppHandAdj !== null) {
    if (pickHandAdj > oppHandAdj + 0.02) handednessAdvantage = 'pick';
    else if (oppHandAdj > pickHandAdj + 0.02) handednessAdvantage = 'opp';
  } else if (pickHandAdj !== null && pickHandAdj > 0.02) {
    handednessAdvantage = 'pick';
  } else if (pickHandAdj !== null && pickHandAdj < -0.02) {
    handednessAdvantage = 'opp';
  }

  const offenseEdgePayload = {
    pickSideWRCplus:    isHome ? model.homeWRCplus : model.awayWRCplus,
    oppSideWRCplus:     isHome ? model.awayWRCplus : model.homeWRCplus,
    handednessAdvantage,
  };

  // v6.10 SABER signal: composite saberWinProb from xFIP delta + wRC+ delta + handedness.
  // Compute a run-differential implied by sabermetrics and convert via sigmoid.
  function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }
  const pickXFIP = pitcherEdgePayload.pickSideXFIP;
  const oppXFIP  = pitcherEdgePayload.oppSideXFIP;
  const pickWRC  = offenseEdgePayload.pickSideWRCplus;
  const oppWRC   = offenseEdgePayload.oppSideWRCplus;
  // xFIP delta: lower xFIP for our pitcher = pick side advantage.
  // positive runDiff = pick side more likely to win.
  let saberRunDiff = 0;
  if (pickXFIP !== null && oppXFIP !== null) {
    // Lower opp xFIP = opp pitcher better = disadvantage for pick side
    // Higher opp xFIP = opp pitcher worse = advantage for pick side
    saberRunDiff += (oppXFIP - pickXFIP) * 0.15; // each 1.0 ERA pt ≈ 0.15 run delta
  }
  if (pickWRC !== null && oppWRC !== null) {
    saberRunDiff += ((pickWRC - oppWRC) / 10) * 0.10;
  }
  if (pickHandAdj !== null) saberRunDiff += pickHandAdj * 0.5;
  // Convert run differential to win probability via sigmoid (scale: 1 run ≈ 10% swing)
  const saberWinProb = Math.round(sigmoid(saberRunDiff * 1.2) * 10000) / 10000;

  // v6.10.3: signal-stack aware unit sizing. Build signals with full context
  // (including saberWinProb, now available) to compute the stack depth.
  const tempSignals = assembleSignals({
    pickSide,
    pickWinProb: pickWp,
    edgePp: pickEdge,
    pickImpliedProb: pickFairMkt,
    sharpPct: resolvedSharpPct,
    predictPct: orientedPoly?.found ? (orientedPoly.pct ?? null) : null,
    openingLine: movement.openingLine ?? null,
    currentLine: movement.currentLine ?? null,
    saberWinProb: saberWinProb,
  });
  const signalStack = computeSignalStack(tempSignals, pickSide);

  // v6.10.4 projection-contradicts trap: projected score implies the OTHER team
  // wins and fewer than 2 proximity-qualified signals back us.
  // With the strict proximity test, stack < 2 is the new threshold — stack=1
  // means only one signal genuinely supports MODEL (e.g. SABER only), which is
  // not enough to override a score projection that points the other way.
  const projDeltaForPickSide = pickSide === 'home'
    ? (model.projHomeScore - model.projAwayScore)
    : (model.projAwayScore - model.projHomeScore);
  const projContradictsPick = projDeltaForPickSide < -0.4;

  if (!hardPass && !phantomEdge && projContradictsPick && signalStack.count < 2) {
    // MODEL says we win on ML but projected score says opponent wins. Fewer than
    // 2 proximity-qualified signals corroborate. Monte-Carlo variance artifact — force PASS.
    verdictTier = 'PASS';
    tier = 'PASS';
    if (!passReason) passReason = 'projection_contradicts_model';
    model.modelNotes.push(
      `v6.10.4 TRAP: projected score has opponent winning by ${(-projDeltaForPickSide).toFixed(2)}r with only ${signalStack.count} proximity-qualified signal(s)`,
    );
  }

  // v6.10.4: apply signal-stack unit adjustment now that signalStack is computed.
  // hardPass / phantomEdge bypass stack adjustment (already PASS / 0 units).
  let units = hardPass || phantomEdge
    ? taperedUnits
    : Math.min(3, Math.max(0, signalStackUnitsAdjustment(taperedUnits, signalStack.count, signalStack.contradicting.length)));

  // If stack adjustment dropped units to 0, force PASS.
  if (units === 0 && taperedUnits > 0 && verdictTier !== 'PASS' && !hardPass && !phantomEdge) {
    verdictTier = 'PASS';
    tier = 'PASS';
    if (!passReason) passReason = 'stack_no_corroboration';
    model.modelNotes.push(`v6.10.4: signal stack count=${signalStack.count} — no proximity-qualified corroboration, PASS`);
  }

  // Phantom forces units and stake to 0 (always, regardless of stack).
  if (phantomEdge) units = 0;
  let stakeDollars = unitsToStake(units, bankroll);
  if (phantomEdge) stakeDollars = 0;

  // qualifies / verdict — computed AFTER all tier mutations (trap, stack, phantom).
  const qualifies = verdictTier !== "PASS" && !hardPass;
  const verdict: "PLAY" | "PASS" = qualifies ? "PLAY" : "PASS";

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
    pitchersAnnounced,
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
    // v6.9.2: DraftKings one-tap deep-link — SNIPER only, null on every other tier.
    dk: buildDkPayload(game._oddsEvent ?? null, verdictTier, pickSide),
    // v6.10: sabermetric edge fields
    _saberWinProb: saberWinProb,
    signalStack,
    pitcherEdge: pitcherEdgePayload,
    offenseEdge: offenseEdgePayload,
  };
}

// Build the DK one-tap payload from the OddsEvent's per-side DK fields.
// v6.9.5: deepLink is always a valid https://sportsbook.draftkings.com/ URL.
// Returns null for non-SNIPER tiers to keep the payload lean.
export function buildDkPayload(
  ev: import("../../adapters/oddsApi").OddsEvent | null,
  tier: string,
  side: "home" | "away",
): { selectionId: string | null; eventId: string; deepLink: string } | null {
  if (tier !== "SNIPER") return null;
  if (!ev?.dkEventId) return null;
  const selectionId = side === "home" ? ev.dkHomeSelectionId : ev.dkAwaySelectionId;
  // Use the adapter-supplied deep link if it’s already a valid DK https URL;
  // otherwise pickToDkLink() returns a reliable sport-level league page.
  const rawLink = side === "home" ? ev.dkHomeDeepLink : ev.dkAwayDeepLink;
  const deepLink = pickToDkLink({ dk: { deepLink: rawLink }, sport: "mlb" });
  return { selectionId, eventId: ev.dkEventId, deepLink };
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
