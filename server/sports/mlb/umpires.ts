// Home-plate umpire ingest (MLB). The MLB Stats API exposes the assigned crew
// on each game's live feed (free, no auth). We pull the HP umpire, then look up
// a 365-day rolling profile cached at data/umpire_stats.json. Profiles capture
// how an umpire's zone shifts run scoring (a tight zone → more walks/runs, a
// wide zone → more strikeouts/fewer runs).
//
// Everything here is best-effort: any failure (network, missing assignment,
// unknown umpire) returns a NEUTRAL adjustment so a pick is never blocked.

import fs from "node:fs";
import path from "node:path";
import { getJson } from "../../adapters/http";

const FEED_URL = (gamePk: string) =>
  `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;

const STATS_PATH = process.env.UMPIRE_STATS_PATH
  ? process.env.UMPIRE_STATS_PATH
  : path.join(process.cwd(), "data", "umpire_stats.json");

// Per-umpire rolling profile (365-day window). runScoreAdjustment is in runs
// per game relative to a neutral umpire: positive = more scoring, negative =
// fewer. kPctDelta / bbPctDelta are percentage-point shifts vs league average.
export interface UmpireProfile {
  umpireId: number;
  name: string;
  games: number;
  avgRunsPerGame: number;
  kPctDelta: number;
  bbPctDelta: number;
  runScoreAdjustment: number;
}

// What predictGame consumes. Neutral when we have no profile.
export interface UmpireAdjustment {
  name: string | null;
  runScoreAdj: number; // runs per game (split across both teams downstream)
  kPctDelta: number;
  bbPctDelta: number;
  found: boolean;
}

export const NEUTRAL_UMPIRE: UmpireAdjustment = {
  name: null,
  runScoreAdj: 0,
  kPctDelta: 0,
  bbPctDelta: 0,
  found: false,
};

interface StatsCache {
  byId: Record<string, UmpireProfile>;
  byName: Record<string, UmpireProfile>;
}

let cache: StatsCache | null = null;

function loadStats(): StatsCache {
  if (cache) return cache;
  const empty: StatsCache = { byId: {}, byName: {} };
  try {
    if (!fs.existsSync(STATS_PATH)) {
      cache = empty;
      return cache;
    }
    const raw = JSON.parse(fs.readFileSync(STATS_PATH, "utf8")) as
      | UmpireProfile[]
      | { umpires?: UmpireProfile[] };
    const list = Array.isArray(raw) ? raw : raw.umpires ?? [];
    const byId: Record<string, UmpireProfile> = {};
    const byName: Record<string, UmpireProfile> = {};
    for (const p of list) {
      if (typeof p.umpireId === "number") byId[String(p.umpireId)] = p;
      if (typeof p.name === "string") byName[normName(p.name)] = p;
    }
    cache = { byId, byName };
  } catch {
    cache = empty;
  }
  return cache;
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Pull the assigned home-plate umpire for a game from the MLB live feed.
// Returns the official's name + id, or null when unavailable.
export async function fetchHomePlateUmpire(
  gamePk: string,
): Promise<{ id: number | null; name: string } | null> {
  try {
    const res = await getJson<{
      liveData?: { boxscore?: { officials?: { official?: { id?: number; fullName?: string }; officialType?: string }[] } };
    }>(FEED_URL(gamePk));
    if (!res.ok || !res.data) return null;
    const officials = res.data.liveData?.boxscore?.officials ?? [];
    const hp = officials.find((o) => o.officialType === "Home Plate");
    if (!hp?.official?.fullName) return null;
    return { id: hp.official.id ?? null, name: hp.official.fullName };
  } catch {
    return null;
  }
}

// Look up a cached profile by id, then name. Returns null when unknown.
export function profileFor(id: number | null, name: string | null): UmpireProfile | null {
  const stats = loadStats();
  if (id !== null && stats.byId[String(id)]) return stats.byId[String(id)];
  if (name && stats.byName[normName(name)]) return stats.byName[normName(name)];
  return null;
}

// Resolve a full umpire adjustment for a game. Never throws; degrades to
// NEUTRAL_UMPIRE when the assignment or profile is missing.
export async function umpireAdjustmentForGame(gamePk: string | null | undefined): Promise<UmpireAdjustment> {
  if (!gamePk) return NEUTRAL_UMPIRE;
  const assigned = await fetchHomePlateUmpire(String(gamePk));
  if (!assigned) return NEUTRAL_UMPIRE;
  const profile = profileFor(assigned.id, assigned.name);
  if (!profile) {
    // We know who is behind the plate but have no history — surface the name
    // with a neutral run adjustment so the brief can still mention the crew.
    return { ...NEUTRAL_UMPIRE, name: assigned.name };
  }
  return {
    name: profile.name,
    runScoreAdj: profile.runScoreAdjustment,
    kPctDelta: profile.kPctDelta,
    bbPctDelta: profile.bbPctDelta,
    found: true,
  };
}

// Surname for compact method-log / brief mentions ("ump(Hoberg, -0.22r)").
export function umpireShortName(name: string | null): string {
  if (!name) return "ump";
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || name;
}

// Reset the in-process cache (tests).
export function _resetUmpireCache(): void {
  cache = null;
}
