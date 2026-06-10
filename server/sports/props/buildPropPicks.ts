// Daily prop pick generation (spec §5). Chains after ingestion: for every stored
// prop offer in the slate, build the line-shopping quote set, run the Monte Carlo
// simulator, compute the edge, compute hit rates, gate, tier, rank, cap, size,
// and write the survivors to prop_picks.
//
// The PURE decision functions (tier, alignment, ranking, cap, stake) live here
// and are unit-tested directly; the async orchestrator (buildMlbPropPicks) wires
// in the data adapters.

import {
  propOffersForDate,
  upsertPropPick,
  setPropOfferPlayerId,
  insertPropAudit,
  type PropOfferRow,
} from "../../gradedBook";
import { fetchSchedule } from "../../adapters/mlbStats";
import { fetchPitcherStats } from "../../adapters/mlbStats";
import { parkFactorForTeam } from "../mlb/weather";
import { nameToAbbr } from "../mlb/teams";
import { fetchBatterProfile, fetchPitcherProfile } from "./mlbStatsProps";
import { resolveMlbPlayerId } from "./playerResolver";
import { findGameForEvent, lineupSpotFor } from "./eventMapper";
import {
  simulate,
  isPitcherMarket,
  isBatterMarket,
  type PropMarket,
  type MatchupContext,
  type SimDistribution,
} from "./simulate";
import { computePropEdge, qualifiesAsPick, type BookQuote, type PropEdgeResult } from "./edge";
import { computeHitRates, hitRateAligned, type HitRates } from "./hitRates";
import { bigDogTaperFactor, pickRankScore } from "../units";

// ── Operating constants (spec §5) ──────────────────────────────────────────

// Flat 0.5u on every prop until 100+ graded results, then revisit. Env override.
export function propStakeUnits(): number {
  const env = Number(process.env.PROP_STAKE_UNITS);
  return Number.isFinite(env) && env > 0 ? env : 0.5;
}

export const PROP_DAILY_CAP = 8;
export const PROP_MAX_AMERICAN = 400; // big-dog taper hard reject above +400 for props
export const MIN_BATTER_LOGS = 20;
export const MIN_PITCHER_STARTS = 8;

// Tier edge thresholds (spec §5; tightened v6.7.6 — post simulator-recalibration,
// a SNIPER must clear ≥6.0pp, since legitimate MLB-prop edges live in 4–10pp).
export const PROP_SNIPER_EDGE = 6.0;
export const PROP_EDGE_EDGE = 6.0;
export const PROP_RECON_EDGE = 4.0;

export type PropTier = "SNIPER" | "EDGE" | "RECON" | "PASS";

// ── Pure tiering ─────────────────────────────────────────────────────────────

export interface TierContext {
  edgePp: number;
  side: "over" | "under";
  l10: HitRates["l10"];
  l20: HitRates["l20"];
  dataQualityTier: string; // HIGH | MEDIUM | LOW
}

// SNIPER: edge ≥ 8 AND L20 aligned AND data HIGH
// EDGE:   edge ≥ 6 AND L10 aligned
// RECON:  edge ≥ 4
// "aligned": OVER → window rate ≥ 0.50; UNDER → ≤ 0.50.
export function assignPropTier(ctx: TierContext): PropTier {
  const dq = ctx.dataQualityTier.toUpperCase();
  if (
    ctx.edgePp >= PROP_SNIPER_EDGE &&
    dq === "HIGH" &&
    hitRateAligned(ctx.l20, ctx.side)
  ) {
    return "SNIPER";
  }
  if (ctx.edgePp >= PROP_EDGE_EDGE && hitRateAligned(ctx.l10, ctx.side)) {
    return "EDGE";
  }
  if (ctx.edgePp >= PROP_RECON_EDGE) {
    return "RECON";
  }
  return "PASS";
}

// ── Confidence (for ranking + display) ───────────────────────────────────────

// A simple confidence proxy from the edge + how decisively the model favors the
// side (distance of model prob from a coin flip). Bounded 50..85 so it reads
// like the game-line confidence scale.
export function propConfidence(edgePp: number, modelProb: number): number {
  const edgeComp = Math.min(20, edgePp); // up to +20
  const probComp = Math.min(15, Math.abs(modelProb - 0.5) * 100); // up to +15
  return Math.round(Math.min(85, 50 + edgeComp + probComp));
}

// ── Stake (flat units, taper, hard reject) ───────────────────────────────────

export interface PropStakeResult {
  units: number;
  rejected: boolean; // price too long (> +400) → no play
}

// Flat 0.5u, then apply the v6.6 big-dog taper to the price, hard-rejecting any
// price longer than +400 (props get a tighter ceiling than game lines).
export function propStake(americanPrice: number): PropStakeResult {
  if (americanPrice > PROP_MAX_AMERICAN) return { units: 0, rejected: true };
  const tapered = propStakeUnits() * bigDogTaperFactor(americanPrice);
  return { units: Math.round(tapered * 100) / 100, rejected: tapered <= 0 };
}

// ── Sample-size gate (spec §5) ───────────────────────────────────────────────

export function hasSufficientSample(
  market: PropMarket,
  batterLogs: number,
  pitcherStarts: number,
): boolean {
  if (isPitcherMarket(market)) return pitcherStarts >= MIN_PITCHER_STARTS;
  return batterLogs >= MIN_BATTER_LOGS;
}

// ── Ranking + daily cap ───────────────────────────────────────────────────────

export interface RankedProp {
  pickId: string;
  edgePp: number;
  confidence: number;
  sampleSize: number;
  tier: PropTier;
}

const TIER_RANK: Record<PropTier, number> = { SNIPER: 0, EDGE: 1, RECON: 2, PASS: 3 };

// Rank by edge × confidence × sqrt(sampleSize) (spec §5), tier first so a SNIPER
// always outranks an EDGE. Returns the top `cap` actionable picks.
export function rankAndCap<T extends RankedProp>(picks: T[], cap = PROP_DAILY_CAP): T[] {
  const actionable = picks.filter((p) => p.tier !== "PASS");
  actionable.sort((a, b) => {
    const r = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (r !== 0) return r;
    return propRankScore(b) - propRankScore(a);
  });
  return actionable.slice(0, cap);
}

export function propRankScore(p: RankedProp): number {
  return p.edgePp * p.confidence * Math.sqrt(Math.max(1, p.sampleSize));
}

// ── Data quality tier ─────────────────────────────────────────────────────────

// HIGH: a full recent window (≥ MIN logs and a season anchor). MEDIUM: partial.
// LOW: thin. Drives the SNIPER/EDGE gates and the surfacing gate.
export function dataQualityTier(
  market: PropMarket,
  logs: number,
  hasSeason: boolean,
): string {
  const min = isPitcherMarket(market) ? MIN_PITCHER_STARTS : MIN_BATTER_LOGS;
  if (logs >= min && hasSeason) return "HIGH";
  if (logs >= Math.ceil(min / 2)) return "MEDIUM";
  return "LOW";
}

// ── Market display label ───────────────────────────────────────────────────────

export const MARKET_LABEL: Record<string, string> = {
  batter_hits: "HITS",
  batter_total_bases: "TOTAL BASES",
  batter_home_runs: "HOME RUNS",
  batter_runs_scored: "RUNS",
  batter_rbis: "RBIS",
  batter_walks: "WALKS",
  batter_singles: "SINGLES",
  pitcher_strikeouts: "STRIKEOUTS",
  pitcher_outs: "OUTS",
  pitcher_earned_runs: "EARNED RUNS",
  pitcher_hits_allowed: "HITS ALLOWED",
  pitcher_walks: "WALKS",
};

export function marketLabel(market: string): string {
  return MARKET_LABEL[market] ?? market.replace(/_/g, " ").toUpperCase();
}

// ── Offer grouping ────────────────────────────────────────────────────────────

export interface GroupedOffer {
  eventId: string;
  player: string;
  market: string;
  line: number; // consensus line (most common across books)
  quotes: BookQuote[];
  playerId: number | null; // resolved MLB Stats id if a prior cycle persisted it
  eventHome: string | null; // Odds API event home team (full name) — game locator
  eventAway: string | null; // Odds API event away team (full name) — game locator
}

// Collapse per-book offer rows into one quote set per (event, player, market),
// keyed line = the modal line across books. Carries through any player_id already
// persisted on the rows (stored as TEXT) so a resolved id survives across cycles.
export function groupOffers(offers: PropOfferRow[]): GroupedOffer[] {
  const by = new Map<string, { ev: string; player: string; market: string; lines: number[]; quotes: BookQuote[]; playerId: number | null; eventHome: string | null; eventAway: string | null }>();
  for (const o of offers) {
    const k = `${o.event_id}|${o.player_name}|${o.market}`;
    const g = by.get(k) ?? { ev: o.event_id, player: o.player_name, market: o.market, lines: [], quotes: [], playerId: null, eventHome: null, eventAway: null };
    g.lines.push(o.line);
    g.quotes.push({ book: o.book, overPrice: o.over_price, underPrice: o.under_price });
    if (g.playerId == null && o.player_id != null) {
      const parsed = Number(o.player_id);
      if (Number.isFinite(parsed) && parsed > 0) g.playerId = parsed;
    }
    if (g.eventHome == null && o.event_home) g.eventHome = o.event_home;
    if (g.eventAway == null && o.event_away) g.eventAway = o.event_away;
    by.set(k, g);
  }
  const out: GroupedOffer[] = [];
  for (const g of by.values()) {
    out.push({ eventId: g.ev, player: g.player, market: g.market, line: modal(g.lines), quotes: g.quotes, playerId: g.playerId, eventHome: g.eventHome, eventAway: g.eventAway });
  }
  return out;
}

function modal(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = xs[0] ?? 0.5;
  let bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

// ── Matchup context build ─────────────────────────────────────────────────────

export interface MatchupBundle {
  context: MatchupContext;
  team: string | null;
  opponent: string | null;
}

// ── Async orchestrator ────────────────────────────────────────────────────────

export interface BuildSummary {
  date: string;
  considered: number;
  written: number;
  pickIds: string[];
}

// Injectable data adapters so the orchestrator's end-to-end chain (resolve id →
// fetch profile → simulate → gate → write) is testable without live HTTP.
// Production passes nothing and the real adapters are used.
export interface BuildDeps {
  resolveId: typeof resolveMlbPlayerId;
  persistId: typeof setPropOfferPlayerId;
  batterProfile: typeof fetchBatterProfile;
  pitcherProfile: typeof fetchPitcherProfile;
  schedule: typeof fetchSchedule;
}
const DEFAULT_BUILD_DEPS: BuildDeps = {
  resolveId: resolveMlbPlayerId,
  persistId: setPropOfferPlayerId,
  batterProfile: fetchBatterProfile,
  pitcherProfile: fetchPitcherProfile,
  schedule: fetchSchedule,
};

// Build the day's MLB prop picks from stored offers. Reads offers for the date,
// joins MLB schedule for matchup context, simulates each, gates + tiers + caps,
// and writes survivors to prop_picks. Degrades to an empty write when there are
// no offers or no player data (no fabricated picks).
export async function buildMlbPropPicks(
  date: string,
  deps: BuildDeps = DEFAULT_BUILD_DEPS,
): Promise<BuildSummary> {
  const offers = propOffersForDate(date, "mlb");
  const grouped = groupOffers(offers);
  if (grouped.length === 0) return { date, considered: 0, written: 0, pickIds: [] };

  // Schedule gives us venue (park factor) + opposing probable pitcher + posted
  // batting orders (for lineup-spot resolution) per event.
  const schedule = await deps.schedule(date, { includeLineups: true }).catch(() => []);

  type Candidate = {
    pickId: string;
    offer: GroupedOffer;
    dist: SimDistribution;
    edge: PropEdgeResult;
    hitRates: HitRates;
    tier: PropTier;
    confidence: number;
    sampleSize: number;
    dq: string;
    team: string | null;
    opponent: string | null;
  };
  const candidates: Candidate[] = [];

  for (const g of grouped) {
    const market = g.market as PropMarket;
    if (!isBatterMarket(market) && !isPitcherMarket(market)) continue;

    // Player profile (game logs + season). Skip when unavailable — no fabrication.
    let batterLogs = 0;
    let pitcherStarts = 0;
    let hasSeason = false;
    let batterProfile: import("./mlbStatsProps").BatterProfile | null = null;
    let pitcherProfile: import("./mlbStatsProps").PitcherProfile | null = null;
    let simInput;
    const seedKey = `${g.eventId}|${g.player}|${market}|${g.line}`;

    // Resolve the MLB Stats player id. The Odds API gives us only a name, so
    // without this every profile fetch short-circuits and no pick is ever built.
    // Use the id carried through from a prior cycle's offer row if present;
    // otherwise look it up by name and persist it back for the next cycle.
    let playerId: number | null = g.playerId;
    if (playerId == null) {
      playerId = await deps.resolveId(g.player).catch(() => null);
      if (playerId != null) {
        try {
          deps.persistId(g.eventId, g.market, g.player, playerId);
        } catch {
          // best-effort persistence; a failed write just means we re-resolve next cycle
        }
      }
    }

    // Build the matchup context (park factor from the event's home venue, the
    // opposing pitcher FIP for batter markets, and the player's lineup spot from
    // the posted batting order). The event→gamePk join now uses team matching
    // (v6.7.3) instead of the broken `gamePk === eventId` compare. Neutral fallback.
    const matchup = await buildMatchup(market, g, schedule, playerId).catch(() => null);
    const ctx: MatchupContext = matchup?.context ?? {
      oppFipRatio: 1,
      parkFactor: 1,
      lineupSpot: 5,
      oppLineupKFactor: 1,
    };

    if (isBatterMarket(market)) {
      const profile = await deps.batterProfile(playerId, g.player, 20).catch(() => null);
      if (!profile || !profile.available) continue;
      batterProfile = profile;
      batterLogs = profile.logs.length;
      hasSeason = profile.seasonRates !== null;
      simInput = { market, batter: profile, matchup: ctx, seedKey };
    } else {
      const profile = await deps.pitcherProfile(playerId, g.player, 20).catch(() => null);
      if (!profile || !profile.available) continue;
      pitcherProfile = profile;
      pitcherStarts = profile.starts;
      hasSeason = profile.seasonRates !== null;
      simInput = { market, pitcher: profile, matchup: ctx, seedKey };
    }

    if (!hasSufficientSample(market, batterLogs, pitcherStarts)) continue;

    const sim = simulate(simInput);
    if (!sim.ok || !sim.distribution) continue;

    const edge = computePropEdge(sim.distribution, g.line, g.quotes);
    if (!edge) continue;

    // Model-outlier sanity gate (v6.7.3). A double-digit-plus edge whose median
    // sits far from the line relative to the simulated spread is almost always a
    // thin-sample artifact, not a real edge. PASS it and record the reason so the
    // filtered set is queryable (SELECT * FROM pick_audit WHERE reason='model_outlier').
    if (
      edge.edgePp > 20 &&
      Math.abs(sim.distribution.median - g.line) > sim.distribution.stdDev * 0.5
    ) {
      const auditId = `${g.eventId}:${market}:${g.player}:${edge.side}`;
      try {
        insertPropAudit(auditId, "prop-build", "model_outlier");
      } catch {
        // audit logging is best-effort; never block the build on it
      }
      continue;
    }

    // Tighter model-outlier gate (v6.7.6). After the simulator recalibration, a
    // legitimate MLB-prop edge lives in 4–10pp; books are sharp. Any edge > 12pp
    // where the model probability diverges from the de-vigged fair market prob by
    // more than 0.15 is the model disagreeing too violently with a sharp market —
    // almost always a residual model error, not a real edge. PASS it and audit.
    if (edge.edgePp > 12 && Math.abs(edge.modelProb - edge.impliedProb) > 0.15) {
      const auditId = `${g.eventId}:${market}:${g.player}:${edge.side}`;
      try {
        insertPropAudit(auditId, "prop-build", "model_outlier_v676");
      } catch {
        // audit logging is best-effort; never block the build on it
      }
      continue;
    }

    const dq = dataQualityTier(market, isBatterMarket(market) ? batterLogs : pitcherStarts, hasSeason);
    if (!qualifiesAsPick(edge, dq)) continue;

    const hitRates = computeHitRates({
      market,
      line: g.line,
      batter: batterProfile ?? undefined,
      pitcher: pitcherProfile ?? undefined,
      opponent: matchup?.opponent ?? null,
    });

    const tier = assignPropTier({ edgePp: edge.edgePp, side: edge.side, l10: hitRates.l10, l20: hitRates.l20, dataQualityTier: dq });
    if (tier === "PASS") continue;

    const stake = propStake(edge.bestPrice);
    if (stake.rejected) continue;

    const confidence = propConfidence(edge.edgePp, edge.modelProb);
    const sampleSize = isBatterMarket(market) ? batterLogs : pitcherStarts;
    candidates.push({
      pickId: `${g.eventId}:${market}:${g.player}:${edge.side}`,
      offer: g,
      dist: sim.distribution,
      edge,
      hitRates,
      tier,
      confidence,
      sampleSize,
      dq,
      team: matchup?.team ?? null,
      opponent: matchup?.opponent ?? null,
    });
  }

  const ranked = rankAndCap(
    candidates.map((c) => ({ ...c, edgePp: c.edge.edgePp })),
    PROP_DAILY_CAP,
  );

  const pickIds: string[] = [];
  for (const c of ranked) {
    const stake = propStake(c.edge.bestPrice);
    upsertPropPick({
      pick_id: c.pickId,
      sport: "mlb",
      game_id: c.offer.eventId,
      player_name: c.offer.player,
      team: c.team,
      opponent: c.opponent,
      market_type: c.offer.market,
      line: c.offer.line,
      side: c.edge.side,
      posted_odds: c.edge.bestPrice,
      tier: c.tier,
      confidence: c.confidence,
      edge_pp: c.edge.edgePp,
      data_quality_tier: c.dq,
      model_prob: c.edge.modelProb,
      sim_median: c.dist.median,
      sim_p25: c.dist.p25,
      sim_p75: c.dist.p75,
      sim_mean: c.dist.mean,
      sim_trials: c.dist.trials,
      hit_rates_json: JSON.stringify(c.hitRates),
      matchup_json: null,
      best_book: c.edge.bestBook,
      best_price: c.edge.bestPrice,
      market_label: marketLabel(c.offer.market),
      stake_units: stake.units,
      hundred_club: c.hitRates.hundredClub,
    });
    pickIds.push(c.pickId);
  }

  return { date, considered: candidates.length, written: pickIds.length, pickIds };
}

// Build matchup context for a market+offer using the schedule. The event→game
// join matches the offer's team(s) against the schedule (v6.7.3 — the prior
// `gamePk === eventId` compare never matched, since eventId is an Odds API hash).
// Park factor comes from the actual home venue; the opposing-pitcher FIP is the
// arm on the OTHER side from the player's team; the lineup spot comes from the
// posted batting order for the player's side (fallback 5).
async function buildMatchup(
  market: PropMarket,
  offer: GroupedOffer,
  schedule: import("../../adapters/mlbStats").ScheduleGame[],
  playerId: number | null,
): Promise<MatchupBundle> {
  // Locate the MLB game by the event's two clubs (the Odds event id is a hash).
  const matched = findGameForEvent({ team: offer.eventHome, opponent: offer.eventAway }, schedule);

  let parkFactor = 1;
  let team: string | null = null;
  let opponent: string | null = null;
  let oppFipRatio = 1;
  let lineupSpot = 5;

  if (matched) {
    parkFactor = parkFactorForTeam(nameToAbbr(matched.homeTeamFull));

    // The props feed doesn't tell us the player's team, so place the player by
    // which posted batting order contains the resolved id. Falls back to "home"
    // for the opponent label (best-effort) when the lineup isn't posted yet.
    const homeSpot = lineupSpotFor(playerId, "home", matched);
    const awaySpot = lineupSpotFor(playerId, "away", matched);
    let side: "home" | "away" | null = null;
    if (homeSpot != null) {
      side = "home";
      lineupSpot = homeSpot;
    } else if (awaySpot != null) {
      side = "away";
      lineupSpot = awaySpot;
    }

    if (side === "home") {
      team = matched.homeTeamFull;
      opponent = matched.awayTeamFull;
    } else if (side === "away") {
      team = matched.awayTeamFull;
      opponent = matched.homeTeamFull;
    } else {
      opponent = matched.awayTeamFull;
    }

    // For a batter market, the relevant arm is the OPPOSING probable starter.
    // When we couldn't place the player's side, default to the home starter.
    if (isBatterMarket(market)) {
      const oppPid = side === "away" ? matched.homePitcherId : matched.awayPitcherId;
      const oppName = side === "away" ? matched.homePitcher : matched.awayPitcher;
      if (oppPid) {
        const sp = await fetchPitcherStats(oppPid, oppName).catch(() => null);
        if (sp?.fip != null && sp.fip > 0) {
          oppFipRatio = clamp(sp.fip / 4.0, 0.7, 1.4);
        }
      }
    }
  }
  return {
    team,
    opponent,
    context: { oppFipRatio, parkFactor, lineupSpot, oppLineupKFactor: 1 },
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
