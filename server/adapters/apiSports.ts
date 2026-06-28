// api-sports.io baseball adapter — additive cross-check feed (v6.12.1).
// https://v1.baseball.api-sports.io  league=1 (MLB).
//
// This feed is purely additive: it is used to corroborate the primary MLB Stats
// API numbers (team RPG/OPS), provide schedule + odds redundancy, and surface
// which feeds are live. It NEVER blocks the slate and NEVER replaces an existing
// model input. Every function short-circuits to {available:false} when
// API_SPORTS_KEY is unset, and returns {available:false} (never throws) on any
// HTTP error or malformed response. Results are cached in-process for 10 minutes
// to respect the api-sports request quota.

import { getJson } from "./http";
import type { TeamOffense } from "../sports/mlb/ratings";
import type { StarterStatcast } from "../sports/mlb/hatfieldRules";

const BASE = "https://v1.baseball.api-sports.io";
const MLB_LEAGUE = 1;
const CACHE_TTL_MS = 10 * 60 * 1000;

export function hasApiSportsKey(): boolean {
  return Boolean(process.env.API_SPORTS_KEY);
}

function key(): Record<string, string> {
  return { "x-apisports-key": process.env.API_SPORTS_KEY as string };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function currentSeason(): number {
  return new Date().getUTCFullYear();
}

// ── 10-minute in-process cache (keyed on path + params) ─────────────────────

const cache = new Map<string, { at: number; value: unknown }>();

function cacheKey(path: string, params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${path}?${entries}`;
}

// Run `fetcher` unless a fresh cached value exists. Caches every resolved value
// (including {available:false}) so a quota-burning retry storm can't happen.
async function cached<T>(
  ck: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await fetcher();
  cache.set(ck, { at: Date.now(), value });
  return value;
}

// ── Schedule cross-check ────────────────────────────────────────────────────

export interface ApiSportsGame {
  id: number | null;
  date: string | null;
  status: string | null;
  home: { id: number | null; name: string | null };
  away: { id: number | null; name: string | null };
  scores: { home: number | null; away: number | null };
}
export interface ApiSportsGamesResult {
  available: boolean;
  games: ApiSportsGame[];
}

interface RawGamesItem {
  id?: number;
  date?: string;
  status?: { long?: string; short?: string };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
  scores?: {
    home?: { total?: number | null };
    away?: { total?: number | null };
  };
}
interface RawGames {
  response?: RawGamesItem[];
}

export async function fetchGamesByDate(
  dateStr: string,
  leagueId: number = MLB_LEAGUE,
  season: number = currentSeason(),
): Promise<ApiSportsGamesResult> {
  if (!hasApiSportsKey()) return { available: false, games: [] };
  const path = `${BASE}/games`;
  const params = { date: dateStr, league: leagueId, season };
  return cached(cacheKey(path, params), async () => {
    const res = await getJson<RawGames>(path, params, key());
    if (!res.ok || !Array.isArray(res.data?.response)) return { available: false, games: [] };
    const games: ApiSportsGame[] = res.data.response.map((g) => ({
      id: g.id ?? null,
      date: g.date ?? null,
      status: g.status?.short ?? g.status?.long ?? null,
      home: { id: g.teams?.home?.id ?? null, name: g.teams?.home?.name ?? null },
      away: { id: g.teams?.away?.id ?? null, name: g.teams?.away?.name ?? null },
      scores: { home: num(g.scores?.home?.total), away: num(g.scores?.away?.total) },
    }));
    return { available: true, games };
  });
}

// ── Team-ID resolution (name → api-sports id) ───────────────────────────────

interface RawTeamSearchItem {
  id?: number;
  name?: string;
}
interface RawTeamSearch {
  response?: RawTeamSearchItem[];
}

// Best-effort resolve an api-sports team id from a full team name. Cached for
// 10 min like everything else. Returns null on miss/failure (xcheck no-ops).
export async function resolveTeamId(
  teamFull: string | null,
  season: number = currentSeason(),
  leagueId: number = MLB_LEAGUE,
): Promise<number | null> {
  if (!hasApiSportsKey() || !teamFull) return null;
  const path = `${BASE}/teams`;
  const params = { search: teamFull, league: leagueId, season };
  return cached(cacheKey(path, params), async () => {
    const res = await getJson<RawTeamSearch>(path, params, key());
    const first = res.ok ? res.data?.response?.[0] : undefined;
    return first?.id ?? null;
  });
}

// ── Team statistics cross-check ─────────────────────────────────────────────

export interface ApiSportsTeamStats {
  available: boolean;
  rpg?: number | null;
  opsLike?: number | null;
  gamesPlayed?: number | null;
}

interface RawTeamStats {
  response?: {
    games?: { played?: { all?: number | string } };
    points?: { for?: { average?: { all?: number | string }; total?: { all?: number | string } } };
    runs?: { for?: { average?: { all?: number | string }; total?: { all?: number | string } } };
  };
}

// Team RPG + an OPS-like proxy (when derivable). The baseball plan exposes
// runs/points "for" averages but not a true OPS, so opsLike is best-effort and
// frequently null — that is expected and reported as a plan limitation.
export async function fetchTeamStatistics(
  teamId: number | null,
  season: number = currentSeason(),
  leagueId: number = MLB_LEAGUE,
): Promise<ApiSportsTeamStats> {
  if (!hasApiSportsKey() || !teamId) return { available: false };
  const path = `${BASE}/teams/statistics`;
  const params = { team: teamId, season, league: leagueId };
  return cached(cacheKey(path, params), async () => {
    const res = await getJson<RawTeamStats>(path, params, key());
    const r = res.ok ? res.data?.response : undefined;
    if (!r) return { available: false };

    // api-sports baseball uses either "runs" or "points" depending on plan/sport
    // wiring — read both defensively.
    const rpg =
      num(r.runs?.for?.average?.all) ?? num(r.points?.for?.average?.all);
    const gamesPlayed = num(r.games?.played?.all);
    if (rpg === null) return { available: false };

    // No true OPS on this plan; leave opsLike null unless a slugging-like proxy
    // is ever exposed. Kept as an explicit field for forward-compat.
    return { available: true, rpg, opsLike: null, gamesPlayed };
  });
}

// ── Standings cross-check ───────────────────────────────────────────────────

export interface ApiSportsStandingRow {
  teamId: number | null;
  teamName: string | null;
  wins: number | null;
  losses: number | null;
  runsFor: number | null;
  runsAgainst: number | null;
}
export interface ApiSportsStandingsResult {
  available: boolean;
  rows: ApiSportsStandingRow[];
}

interface RawStandingTeam {
  team?: { id?: number; name?: string };
  games?: { win?: { total?: number }; lose?: { total?: number } };
  points?: { for?: number; against?: number };
}
interface RawStandings {
  // api-sports returns response as a nested array of groups
  response?: RawStandingTeam[][] | RawStandingTeam[];
}

export async function fetchStandings(
  leagueId: number = MLB_LEAGUE,
  season: number = currentSeason(),
): Promise<ApiSportsStandingsResult> {
  if (!hasApiSportsKey()) return { available: false, rows: [] };
  const path = `${BASE}/standings`;
  const params = { league: leagueId, season };
  return cached(cacheKey(path, params), async () => {
    const res = await getJson<RawStandings>(path, params, key());
    const raw = res.ok ? res.data?.response : undefined;
    if (!Array.isArray(raw)) return { available: false, rows: [] };
    // Flatten one level if the response is grouped (array of arrays).
    const flat: RawStandingTeam[] = (raw as unknown[]).flat() as RawStandingTeam[];
    const rows: ApiSportsStandingRow[] = flat.map((t) => ({
      teamId: t.team?.id ?? null,
      teamName: t.team?.name ?? null,
      wins: num(t.games?.win?.total),
      losses: num(t.games?.lose?.total),
      runsFor: num(t.points?.for),
      runsAgainst: num(t.points?.against),
    }));
    return { available: true, rows };
  });
}

// ── Odds redundancy ─────────────────────────────────────────────────────────

export interface ApiSportsBook {
  name: string | null;
  h2hHome: number | null;
  h2hAway: number | null;
}
export interface ApiSportsOddsResult {
  available: boolean;
  books: ApiSportsBook[];
}

interface RawOddsValue {
  value?: string;
  odd?: string | number;
}
interface RawOddsBet {
  name?: string;
  values?: RawOddsValue[];
}
interface RawOddsBookmaker {
  name?: string;
  bets?: RawOddsBet[];
}
interface RawOddsItem {
  bookmakers?: RawOddsBookmaker[];
}
interface RawOdds {
  response?: RawOddsItem[];
}

export async function fetchOddsForGame(gameId: number | null): Promise<ApiSportsOddsResult> {
  if (!hasApiSportsKey() || !gameId) return { available: false, books: [] };
  const path = `${BASE}/odds`;
  const params = { game: gameId };
  return cached(cacheKey(path, params), async () => {
    const res = await getJson<RawOdds>(path, params, key());
    const item = res.ok ? res.data?.response?.[0] : undefined;
    if (!item || !Array.isArray(item.bookmakers)) return { available: false, books: [] };
    const books: ApiSportsBook[] = item.bookmakers.map((bm) => {
      // Find the moneyline / home-away bet. Names vary ("Home/Away", "Money Line").
      const bet = (bm.bets ?? []).find((b) =>
        /home\/away|money\s*line|moneyline|winner/i.test(b.name ?? ""),
      );
      const values = bet?.values ?? [];
      const home = values.find((v) => /home|1/i.test(v.value ?? ""));
      const away = values.find((v) => /away|2/i.test(v.value ?? ""));
      return {
        name: bm.name ?? null,
        h2hHome: num(home?.odd),
        h2hAway: num(away?.odd),
      };
    });
    return { available: true, books };
  });
}

// ── Pitcher Statcast (Hatfield contact-quality stack, v6.13.0) ──────────────
// Best-effort pull of a starter's xERA / xBA-allowed / barrel% / sweet-spot% /
// walk% from the api-sports player-statistics endpoint. The baseball plan does
// NOT expose true Statcast fields, so in practice these read null and the model
// falls back to league average (Rule 2) / no-op (Rule 1/3). Defensive: missing
// fields stay null, errors/no-key degrade to an all-null StarterStatcast.

interface RawPlayerStatItem {
  statistics?: Array<{
    pitching?: {
      era?: number | string | null;
      xera?: number | string | null;
      expected_era?: number | string | null;
      xba?: number | string | null;
      xba_allowed?: number | string | null;
      barrel_rate?: number | string | null;
      barrels?: number | string | null;
      sweet_spot?: number | string | null;
      sweet_spot_percent?: number | string | null;
      walks?: { percent?: number | string | null };
      bb_percent?: number | string | null;
    };
  }>;
}
interface RawPlayerStats {
  response?: RawPlayerStatItem[];
}

const NULL_STATCAST: StarterStatcast = {
  era: null,
  xera: null,
  xbaAllowed: null,
  barrelRatePct: null,
  sweetSpotPct: null,
  bbPct: null,
};

export async function fetchPitcherStatcast(
  playerId: number | null,
  season: number = currentSeason(),
  leagueId: number = MLB_LEAGUE,
): Promise<StarterStatcast> {
  if (!hasApiSportsKey() || !playerId) return { ...NULL_STATCAST };
  const path = `${BASE}/players/statistics`;
  const params = { id: playerId, season, league: leagueId };
  return cached(cacheKey(path, params), async () => {
    const res = await getJson<RawPlayerStats>(path, params, key());
    const p = res.ok ? res.data?.response?.[0]?.statistics?.[0]?.pitching : undefined;
    if (!p) return { ...NULL_STATCAST };
    return {
      era: num(p.era),
      xera: num(p.xera) ?? num(p.expected_era),
      xbaAllowed: num(p.xba_allowed) ?? num(p.xba),
      barrelRatePct: num(p.barrel_rate) ?? num(p.barrels),
      sweetSpotPct: num(p.sweet_spot_percent) ?? num(p.sweet_spot),
      bbPct: num(p.bb_percent) ?? num(p.walks?.percent),
    };
  });
}

// ── Backward-compat: TeamOffense wrapper ────────────────────────────────────
// Preserves the original signature/shape so any legacy caller keeps working.
// Delegates to the new fetchTeamStatistics.

export async function fetchTeamOffense(teamId: number | null, season: number): Promise<TeamOffense> {
  const stats = await fetchTeamStatistics(teamId, season);
  if (!stats.available || stats.rpg === null || stats.rpg === undefined || stats.rpg <= 0) {
    return { available: false };
  }
  return { available: true, rpg: stats.rpg, ops: stats.opsLike ?? null };
}
