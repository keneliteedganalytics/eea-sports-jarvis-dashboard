// Live in-game prop tracking (v6.7.3). For each active prop pick on the slate,
// pull the player's accumulating stat from the MLB Stats live feed and compute
// where the prop stands vs. its line:
//   pending    — no in-game data yet (game scheduled, or player not found)
//   live_clear — game in progress, not yet decided either way
//   busted     — the prop has already mathematically lost mid-game
//   paid       — the prop has clinched a win (or the game went final a winner)
//
// The card UI turns green while clear, red on bust, and shows a PAID badge once
// the game is final and the prop won. Everything is best-effort: a missing feed
// or unresolved game leaves the prop "pending".

import { getJson } from "../../adapters/http";
import { inningsToOuts } from "./mlbStatsProps";
import { resolveGamePk, type EventTeams } from "./eventMapper";
import { isPitcherMarket } from "./simulate";
import type { ScheduleGame } from "../../adapters/mlbStats";

const LIVE_BASE = "https://statsapi.mlb.com/api/v1.1";

export type LiveState = "pending" | "live_clear" | "busted" | "paid";
export type GameStatus = "scheduled" | "live" | "final";

// The minimal prop shape the tracker needs (a subset of PropPickRow).
export interface TrackedProp {
  pick_id: string;
  game_id: string; // Odds API event id
  player_name: string;
  market_type: string;
  line: number;
  side: "over" | "under";
  team?: string | null;
  opponent?: string | null;
  player_id?: number | null; // resolved MLB Stats id, if known
}

export interface LiveTracking {
  liveState: LiveState;
  currentValue: number | null;
  gameStatus: GameStatus;
}

// ── Pure state computation ──────────────────────────────────────────────────

// Decide a prop's live disposition from its current accumulated value. For a
// settled game the over needs to have reached the next whole number above the
// line (line 1.5 → needs 2); the under must have stayed at/below the floor
// (line 1.5 → must be ≤ 1). Mid-game: an over that already cleared is "paid"
// (can't un-happen); an under that exceeded its floor is "busted"; otherwise
// the prop is still live.
export function computeLiveState(
  pick: { side: "over" | "under"; line: number },
  currentValue: number,
  gameIsFinal: boolean,
): LiveState {
  if (gameIsFinal) {
    if (pick.side === "over") return currentValue >= Math.ceil(pick.line) ? "paid" : "busted";
    return currentValue <= Math.floor(pick.line) ? "paid" : "busted";
  }
  if (pick.side === "over") {
    if (currentValue >= Math.ceil(pick.line)) return "paid";
    return "live_clear";
  }
  // under, in progress
  if (currentValue > Math.floor(pick.line)) return "busted";
  return "live_clear";
}

// ── Live feed parsing ───────────────────────────────────────────────────────

interface RawPlayerStats {
  batting?: Record<string, number | string | undefined>;
  pitching?: Record<string, number | string | undefined>;
}
interface RawPlayer {
  person?: { id?: number; fullName?: string };
  stats?: RawPlayerStats;
}
interface RawTeamBox {
  players?: Record<string, RawPlayer>;
}
interface RawLiveFeed {
  gameData?: { status?: { abstractGameState?: string; detailedState?: string } };
  liveData?: {
    boxscore?: { teams?: { home?: RawTeamBox; away?: RawTeamBox } };
  };
}

function num(v: number | string | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = Number(v);
  return Number.isNaN(x) ? 0 : x;
}

// Map a prop market to the player's current accumulated value from the live
// boxscore stat node. Singles are derived (hits − 2B − 3B − HR); pitcher outs
// are derived from inningsPitched ("5.2" → 17). Returns null when the relevant
// stat group is absent.
export function statForMarket(market: string, stats: RawPlayerStats | undefined): number | null {
  if (!stats) return null;
  const b = stats.batting;
  const p = stats.pitching;
  switch (market) {
    case "batter_hits": return b ? num(b.hits) : null;
    case "batter_total_bases": return b ? num(b.totalBases) : null;
    case "batter_home_runs": return b ? num(b.homeRuns) : null;
    case "batter_runs_scored": return b ? num(b.runs) : null;
    case "batter_rbis": return b ? num(b.rbi) : null;
    case "batter_walks": return b ? num(b.baseOnBalls) : null;
    case "batter_singles":
      return b ? Math.max(0, num(b.hits) - num(b.doubles) - num(b.triples) - num(b.homeRuns)) : null;
    case "pitcher_strikeouts": return p ? num(p.strikeOuts) : null;
    case "pitcher_outs": return p ? inningsToOuts(p.inningsPitched as string | number | undefined) : null;
    case "pitcher_earned_runs": return p ? num(p.earnedRuns) : null;
    case "pitcher_hits_allowed": return p ? num(p.hits) : null;
    case "pitcher_walks": return p ? num(p.baseOnBalls) : null;
    default: return null;
  }
}

function gameStatusFrom(feed: RawLiveFeed): GameStatus {
  const abstract = (feed.gameData?.status?.abstractGameState ?? "").toLowerCase();
  if (abstract === "final") return "final";
  if (abstract === "live") return "live";
  return "scheduled";
}

// Find a player's current stat node in the boxscore by resolved id (preferred)
// or by full-name match. The boxscore keys players as "ID<playerId>".
function findPlayerStats(
  feed: RawLiveFeed,
  playerId: number | null,
  playerName: string,
): RawPlayerStats | undefined {
  const teams = feed.liveData?.boxscore?.teams;
  if (!teams) return undefined;
  const sides = [teams.home, teams.away].filter(Boolean) as RawTeamBox[];
  if (playerId != null) {
    const key = `ID${playerId}`;
    for (const side of sides) {
      const hit = side.players?.[key];
      if (hit?.stats) return hit.stats;
    }
  }
  const wanted = playerName.toLowerCase();
  for (const side of sides) {
    for (const pl of Object.values(side.players ?? {})) {
      if ((pl.person?.fullName ?? "").toLowerCase() === wanted) return pl.stats;
    }
  }
  return undefined;
}

// ── Dependency injection for testability ────────────────────────────────────

export interface LiveTrackingDeps {
  // Fetch the live feed for a gamePk; null when unavailable. The shape is the
  // raw MLB Stats feed/live JSON (only the fields we read are typed).
  fetchLiveFeed: (gamePk: string) => Promise<RawLiveFeed | null>;
  // Resolve a player name to an MLB id (used when the pick has no id yet).
  resolvePlayerId: (name: string) => Promise<number | null>;
  // The day's schedule (lineups not required here — just team→gamePk mapping).
  schedule: ScheduleGame[];
}

async function defaultFetchLiveFeed(gamePk: string): Promise<RawLiveFeed | null> {
  const res = await getJson<RawLiveFeed>(`${LIVE_BASE}/game/${gamePk}/feed/live`);
  return res.ok ? res.data : null;
}

// Compute live tracking for a set of picks. Resolves each pick's gamePk from the
// schedule (by team), pulls the feed (one fetch per distinct gamePk), finds the
// player, maps the market to its current value, and computes the state. Picks
// whose game can't be resolved stay "pending".
export async function computeLiveTracking(
  picks: TrackedProp[],
  deps: LiveTrackingDeps,
): Promise<Record<string, LiveTracking>> {
  const out: Record<string, LiveTracking> = {};
  const feedCache = new Map<string, RawLiveFeed | null>();

  for (const pick of picks) {
    const pending: LiveTracking = { liveState: "pending", currentValue: null, gameStatus: "scheduled" };

    const eventTeams: EventTeams = { team: pick.team ?? null, opponent: pick.opponent ?? null };
    const gamePk = resolveGamePk(eventTeams, deps.schedule);
    if (!gamePk) {
      out[pick.pick_id] = pending;
      continue;
    }

    let feed = feedCache.get(gamePk);
    if (feed === undefined) {
      feed = await deps.fetchLiveFeed(gamePk).catch(() => null);
      feedCache.set(gamePk, feed);
    }
    if (!feed) {
      out[pick.pick_id] = pending;
      continue;
    }

    const gameStatus = gameStatusFrom(feed);
    if (gameStatus === "scheduled") {
      out[pick.pick_id] = { liveState: "pending", currentValue: null, gameStatus };
      continue;
    }

    let playerId = pick.player_id ?? null;
    let stats = findPlayerStats(feed, playerId, pick.player_name);
    if (!stats && playerId == null) {
      playerId = await deps.resolvePlayerId(pick.player_name).catch(() => null);
      if (playerId != null) stats = findPlayerStats(feed, playerId, pick.player_name);
    }

    const value = statForMarket(pick.market_type, stats);
    // No stat line yet (player hasn't appeared). For a batter that means 0 so
    // far; treat a present-but-statless boxscore as 0, and a missing player as
    // pending. We can tell them apart: stats undefined → pending.
    if (value === null) {
      // Pitcher markets with no pitching node, or batters not yet in the box.
      const fallback = isPitcherMarket(pick.market_type) ? null : 0;
      if (fallback === null) {
        out[pick.pick_id] = { liveState: "pending", currentValue: null, gameStatus };
        continue;
      }
      const liveState = computeLiveState(pick, 0, gameStatus === "final");
      out[pick.pick_id] = { liveState, currentValue: 0, gameStatus };
      continue;
    }

    const liveState = computeLiveState(pick, value, gameStatus === "final");
    out[pick.pick_id] = { liveState, currentValue: value, gameStatus };
  }

  return out;
}

export const DEFAULT_LIVE_DEPS = { fetchLiveFeed: defaultFetchLiveFeed };
