// Hit-rate framework. For a (player, market, line) tuple, how often did the
// player's actual stat clear the posted line over recent windows and situational
// splits. These are descriptive signals shown on the card and used by the tier
// gate ("L20 hit rate aligned with the pick side"); they do not drive the edge
// (the Monte Carlo does that).
//
// Results are cached per (player, market, line) — recompute when the line moves.

import type { BatterGameLog, PitcherGameLog, BatterProfile, PitcherProfile } from "./mlbStatsProps";
import type { BatterMarket, PitcherMarket, PropMarket } from "./simulate";
import { isBatterMarket } from "./simulate";

export interface HitRateWindow {
  decided: number; // games with data
  over: number; // games strictly over the line
  rate: number | null; // over / decided, null when no games
}

export interface HitRates {
  l5: HitRateWindow;
  l10: HitRateWindow;
  l20: HitRateWindow;
  season: HitRateWindow;
  home: HitRateWindow;
  away: HitRateWindow;
  vsLhp: HitRateWindow;
  vsRhp: HitRateWindow;
  vsOpponentL10: HitRateWindow;
  // "100% Club": L5 hit rate is exactly 1.0 (always over) OR 0.0 (always under).
  // Either is a strong directional signal. The flagged direction tells the UI
  // whether the streak points OVER or UNDER.
  hundredClub: boolean;
  hundredClubDirection: "over" | "under" | null;
}

function emptyWindow(): HitRateWindow {
  return { decided: 0, over: 0, rate: null };
}

function statForBatter(g: BatterGameLog, market: BatterMarket): number {
  switch (market) {
    case "batter_hits": return g.hits;
    case "batter_total_bases": return g.totalBases;
    case "batter_home_runs": return g.homeRuns;
    case "batter_runs_scored": return g.runs;
    case "batter_rbis": return g.rbi;
    case "batter_walks": return g.walks;
    case "batter_singles": return g.singles;
  }
}

function statForPitcher(g: PitcherGameLog, market: PitcherMarket): number {
  switch (market) {
    case "pitcher_strikeouts": return g.strikeouts;
    case "pitcher_outs": return g.outs;
    case "pitcher_earned_runs": return g.earnedRuns;
    case "pitcher_hits_allowed": return g.hitsAllowed;
    case "pitcher_walks": return g.walks;
  }
}

// Window over the first N entries (logs are newest-first). A game counts as
// "over" when actual > line; exactly on the line is not an over (push).
function windowRate(values: number[], line: number, n: number): HitRateWindow {
  const slice = values.slice(0, n);
  if (slice.length === 0) return emptyWindow();
  const over = slice.filter((v) => v > line).length;
  return { decided: slice.length, over, rate: round3(over / slice.length) };
}

function filteredRate(
  entries: { value: number; keep: boolean }[],
  line: number,
  limit = Infinity,
): HitRateWindow {
  const kept = entries.filter((e) => e.keep).slice(0, limit).map((e) => e.value);
  if (kept.length === 0) return emptyWindow();
  const over = kept.filter((v) => v > line).length;
  return { decided: kept.length, over, rate: round3(over / kept.length) };
}

export interface HitRateInput {
  market: PropMarket;
  line: number;
  batter?: BatterProfile;
  pitcher?: PitcherProfile;
  opponent?: string | null; // opponent abbrev/name to match in logs (best-effort)
}

// Cache keyed by player|market|line. Invalidated implicitly: a different line
// produces a different key, and the simulator/builder re-keys when the line moves.
const cache = new Map<string, HitRates>();

export function hitRateCacheKey(player: string, market: string, line: number): string {
  return `${player}|${market}|${line}`;
}

export function clearHitRateCache(): void {
  cache.clear();
}

export function computeHitRates(input: HitRateInput): HitRates {
  const player = input.batter?.name ?? input.pitcher?.name ?? "";
  const key = hitRateCacheKey(player, input.market, input.line);
  const cached = cache.get(key);
  if (cached) return cached;

  const result = isBatterMarket(input.market)
    ? batterHitRates(input.batter, input.market, input.line)
    : pitcherHitRates(input.pitcher, input.market as PitcherMarket, input.line);
  cache.set(key, result);
  return result;
}

function batterHitRates(
  profile: BatterProfile | undefined,
  market: BatterMarket,
  line: number,
): HitRates {
  const logs = profile?.logs ?? [];
  const values = logs.map((g) => statForBatter(g, market));

  const l5 = windowRate(values, line, 5);
  const result: HitRates = {
    l5,
    l10: windowRate(values, line, 10),
    l20: windowRate(values, line, 20),
    season: windowRate(values, line, values.length),
    home: filteredRate(logs.map((g) => ({ value: statForBatter(g, market), keep: g.home })), line),
    away: filteredRate(logs.map((g) => ({ value: statForBatter(g, market), keep: !g.home })), line),
    vsLhp: filteredRate(
      logs.map((g) => ({ value: statForBatter(g, market), keep: g.oppPitcherHand === "L" })),
      line,
    ),
    vsRhp: filteredRate(
      logs.map((g) => ({ value: statForBatter(g, market), keep: g.oppPitcherHand === "R" })),
      line,
    ),
    vsOpponentL10: emptyWindow(), // opponent not tagged on the batter log; left empty
    hundredClub: false,
    hundredClubDirection: null,
  };
  applyHundredClub(result);
  return result;
}

function pitcherHitRates(
  profile: PitcherProfile | undefined,
  market: PitcherMarket,
  line: number,
): HitRates {
  const logs = profile?.logs ?? [];
  const values = logs.map((g) => statForPitcher(g, market));
  const result: HitRates = {
    l5: windowRate(values, line, 5),
    l10: windowRate(values, line, 10),
    l20: windowRate(values, line, 20),
    season: windowRate(values, line, values.length),
    home: filteredRate(logs.map((g) => ({ value: statForPitcher(g, market), keep: g.home })), line),
    away: filteredRate(logs.map((g) => ({ value: statForPitcher(g, market), keep: !g.home })), line),
    vsLhp: emptyWindow(),
    vsRhp: emptyWindow(),
    vsOpponentL10: emptyWindow(),
    hundredClub: false,
    hundredClubDirection: null,
  };
  applyHundredClub(result);
  return result;
}

// "100% Club": L5 is all-over (1.0) or all-under (0.0), requiring a full 5-game
// window so a 1-game sample doesn't masquerade as a streak.
function applyHundredClub(r: HitRates): void {
  if (r.l5.decided >= 5 && r.l5.rate !== null) {
    if (r.l5.rate === 1) {
      r.hundredClub = true;
      r.hundredClubDirection = "over";
    } else if (r.l5.rate === 0) {
      r.hundredClub = true;
      r.hundredClubDirection = "under";
    }
  }
}

// Tier-gate helper (spec §5): a hit rate is "aligned" with the pick side when an
// OVER pick has L-window rate ≥ 0.50, or an UNDER pick has rate ≤ 0.50.
export function hitRateAligned(
  window: HitRateWindow,
  side: "over" | "under",
): boolean {
  if (window.rate === null) return false;
  return side === "over" ? window.rate >= 0.5 : window.rate <= 0.5;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
