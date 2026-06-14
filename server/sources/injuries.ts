// Pillar 2 (v6.9.0) — injury / lineup ingest. The existing lineups.ts flags a
// named star missing from a POSTED lineup; this module is the deeper read
// Foxtail-style models use: who is on the IL, and which top-of-order bats are
// out (IL, or DTD and not in the posted lineup), each carrying their season wOBA
// so the projection can subtract the right amount of offense.
//
// Sources (MLB Stats API, no key, best-effort, cached 5min):
//   - /teams/{id}/roster?rosterType=injuryList → who's on the IL
//   - /api/v1.1/game/{gamePk}/feed/live → liveData.boxscore.teams.{home,away}.battingOrder
//
// Wiring contract (applied by the model, SHADOW-gated): subtract
//   KEY_BAT_WOBA_PENALTY (0.020) × (count of key bats out), capped at
//   MAX_WOBA_PENALTY (0.060), from the team's projected wOBA. Tier guard: if the
// model backs TEAM_X and 2+ key bats are out for TEAM_X, demote SNIPER→EDGE.

import { getJson } from "../adapters/http";

const STATS = "https://statsapi.mlb.com/api/v1";
const STATS11 = "https://statsapi.mlb.com/api/v1.1";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5min

export const KEY_BAT_WOBA_PENALTY = 0.02; // per key bat out
export const MAX_WOBA_PENALTY = 0.06; // cap (≈3 bats)
export const KEY_BAT_COUNT = 6; // "key" = top-6 by season wOBA
export const SNIPER_DEMOTE_KEY_BATS_OUT = 2; // 2+ out on the backed side → demote

export interface KeyBatOut {
  playerId: number;
  name: string;
  seasonWoba: number | null;
  reason: "IL" | "DTD_not_in_lineup";
}

export interface InjuryAssessment {
  found: boolean;
  keyBatsOut: KeyBatOut[];
  wobaPenalty: number; // already capped
}

export const NEUTRAL_INJURY: InjuryAssessment = { found: false, keyBatsOut: [], wobaPenalty: 0 };

// Pure: cap the wOBA penalty for N key bats out. Exported for tests.
export function wobaPenaltyFor(count: number): number {
  return Math.min(MAX_WOBA_PENALTY, Math.max(0, count) * KEY_BAT_WOBA_PENALTY);
}

// Pure: should a SNIPER pick backing this side be demoted? Exported for tests.
export function injuryForcesSniperDemotion(keyBatsOut: number): boolean {
  return keyBatsOut >= SNIPER_DEMOTE_KEY_BATS_OUT;
}

interface RawRosterEntry {
  person?: { id?: number; fullName?: string };
  status?: { description?: string };
}
interface RawRoster {
  roster?: RawRosterEntry[];
}

interface RawBoxTeam {
  battingOrder?: number[];
  players?: Record<string, { person?: { id?: number; fullName?: string } }>;
}
interface RawLiveFeed {
  liveData?: { boxscore?: { teams?: { home?: RawBoxTeam; away?: RawBoxTeam } } };
}

interface CacheEntry<T> { at: number; value: T; }
const ilCache = new Map<number, CacheEntry<Set<number>>>();
const boxCache = new Map<string, CacheEntry<RawLiveFeed>>();

function fresh<T>(e: CacheEntry<T> | undefined): T | null {
  if (e && Date.now() - e.at < CACHE_TTL_MS) return e.value;
  return null;
}

// Player ids currently on a team's injury list. Best-effort; cached 5min.
export async function fetchInjuryListIds(teamId: number | null): Promise<Set<number>> {
  if (!teamId) return new Set();
  const hit = fresh(ilCache.get(teamId));
  if (hit) return hit;
  try {
    const res = await getJson<RawRoster>(`${STATS}/teams/${teamId}/roster`, {
      rosterType: "injuryList",
    });
    const ids = new Set<number>();
    for (const e of res.data?.roster ?? []) {
      if (typeof e.person?.id === "number") ids.add(e.person.id);
    }
    ilCache.set(teamId, { at: Date.now(), value: ids });
    return ids;
  } catch {
    return new Set();
  }
}

// Posted batting-order player ids for a game, per side. Best-effort; cached 5min.
export async function fetchBattingOrders(
  gamePk: string | null,
): Promise<{ home: number[]; away: number[] }> {
  const empty = { home: [], away: [] };
  if (!gamePk) return empty;
  let feed = fresh(boxCache.get(gamePk));
  if (!feed) {
    try {
      const res = await getJson<RawLiveFeed>(`${STATS11}/game/${gamePk}/feed/live`);
      if (!res.ok || !res.data) return empty;
      feed = res.data;
      boxCache.set(gamePk, { at: Date.now(), value: feed });
    } catch {
      return empty;
    }
  }
  const teams = feed.liveData?.boxscore?.teams;
  return {
    home: teams?.home?.battingOrder ?? [],
    away: teams?.away?.battingOrder ?? [],
  };
}

// A roster of bats with season wOBA, supplied by the caller (we don't fetch
// per-player season splits here). Top-6 by wOBA are the "key" bats.
export interface RosterBat {
  playerId: number;
  name: string;
  seasonWoba: number | null;
}

// Pure core: given a team's bats (with season wOBA), the IL id set, and the
// posted batting order, return the key bats that are out. Exported for tests so
// the network layer doesn't have to be stubbed.
export function assessKeyBatsOut(
  bats: RosterBat[],
  ilIds: Set<number>,
  postedOrder: number[],
): InjuryAssessment {
  if (bats.length === 0) return NEUTRAL_INJURY;
  const keyBats = [...bats]
    .sort((a, b) => (b.seasonWoba ?? 0) - (a.seasonWoba ?? 0))
    .slice(0, KEY_BAT_COUNT);
  const posted = new Set(postedOrder);
  const lineupPosted = postedOrder.length > 0;
  const out: KeyBatOut[] = [];
  for (const bat of keyBats) {
    if (ilIds.has(bat.playerId)) {
      out.push({ playerId: bat.playerId, name: bat.name, seasonWoba: bat.seasonWoba, reason: "IL" });
    } else if (lineupPosted && !posted.has(bat.playerId)) {
      out.push({
        playerId: bat.playerId, name: bat.name, seasonWoba: bat.seasonWoba,
        reason: "DTD_not_in_lineup",
      });
    }
  }
  return { found: true, keyBatsOut: out, wobaPenalty: wobaPenaltyFor(out.length) };
}

// Best-effort end-to-end: fetch IL + batting order, assess against the supplied
// roster bats. Side picks which battingOrder to compare. Degrades to NEUTRAL.
export async function isKeyBatOut(
  teamId: number | null,
  gamePk: string | null,
  side: "home" | "away",
  bats: RosterBat[],
): Promise<InjuryAssessment> {
  try {
    if (!teamId || bats.length === 0) return NEUTRAL_INJURY;
    const [ilIds, orders] = await Promise.all([
      fetchInjuryListIds(teamId),
      fetchBattingOrders(gamePk),
    ]);
    const posted = side === "home" ? orders.home : orders.away;
    return assessKeyBatsOut(bats, ilIds, posted);
  } catch {
    return NEUTRAL_INJURY;
  }
}

export function _resetInjuryCache(): void {
  ilCache.clear();
  boxCache.clear();
}
