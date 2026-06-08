// api-sports.io football adapter — v3 base URL (NOT v1).
// https://v3.football.api-sports.io
// Used for soccer team goal stats (goals-for, goals-against per game).
// Header: x-apisports-key

import { getJson } from "./http";
import { SOCCER_LEAGUES } from "../sports/soccer/leagues";
import type { TeamGoalStats } from "../sports/soccer/model";

const BASE = "https://v3.football.api-sports.io";

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

interface RawTeamSearch {
  response?: Array<{ team?: { id?: number; name?: string } }>;
}

interface RawTeamStats {
  response?: {
    goals?: {
      for?: {
        average?: { total?: string | number };
        total?: { total?: number };
      };
      against?: {
        average?: { total?: string | number };
        total?: { total?: number };
      };
    };
    form?: string;
  };
}

interface RawFixtures {
  response?: Array<{
    fixture?: {
      id?: number;
      date?: string;
      status?: { short?: string };
    };
    league?: { id?: number; name?: string; season?: number };
    teams?: {
      home?: { id?: number; name?: string };
      away?: { id?: number; name?: string };
    };
  }>;
}

interface RawPrediction {
  response?: Array<{
    predictions?: {
      winner?: { id?: number; name?: string };
      percent?: { home?: string; draw?: string; away?: string };
    };
  }>;
}

// In-process caches — valid for the lifetime of the Node.js process.
// Soccer team stats and name→ID mappings don't change mid-season.
const _statsCache = new Map<string, TeamGoalStats>();    // teamId:leagueId:season → stats
const _teamIdCache = new Map<string, number | null>();   // "name:leagueId" → teamId

// Resolve a team ID by searching the football API.
// Cached by (teamName, leagueId) to avoid repeated lookups.
async function resolveTeamId(teamName: string, leagueId: number): Promise<number | null> {
  const nameCacheKey = `${teamName}:${leagueId}`;
  const cached = _teamIdCache.get(nameCacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await getJson<RawTeamSearch>(
      `${BASE}/teams`,
      { search: teamName, league: leagueId },
      key(),
    );
    const first = res.ok ? res.data?.response?.[0]?.team : undefined;
    const id = first?.id ?? null;
    _teamIdCache.set(nameCacheKey, id);
    return id;
  } catch {
    _teamIdCache.set(nameCacheKey, null);
    return null;
  }
}

// Fetch team statistics by known team ID + league + season (no resolve step).
export async function fetchTeamStatsByTeamId(
  teamId: number,
  leagueId: number,
  season: number,
): Promise<TeamGoalStats> {
  if (!hasApiSportsKey()) return { available: false };
  const cacheKey = `${teamId}:${leagueId}:${season}`;
  const cached = _statsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await getJson<RawTeamStats>(
      `${BASE}/teams/statistics`,
      { team: teamId, league: leagueId, season },
      key(),
    );
    const g = res.ok ? res.data?.response?.goals : undefined;
    const gpg = g ? num(g.for?.average?.total) : null;
    const gapg = g ? num(g.against?.average?.total) : null;
    const form = res.data?.response?.form ?? null;
    const result: TeamGoalStats =
      gpg !== null || gapg !== null
        ? { available: true, gpg, gapg, form: form ? form.slice(-5) : null }
        : { available: false };
    _statsCache.set(cacheKey, result);
    return result;
  } catch {
    const result: TeamGoalStats = { available: false };
    _statsCache.set(cacheKey, result);
    return result;
  }
}

// Fetch team statistics for a given team name + league + season.
// Uses two API calls: name→ID resolve, then stats fetch.
// Cached by team ID + league + season after first resolve.
export async function fetchFootballTeamStats(
  teamName: string,
  leagueId: number,
  season: number,
): Promise<TeamGoalStats> {
  if (!hasApiSportsKey()) return { available: false };
  try {
    const teamId = await resolveTeamId(teamName, leagueId);
    if (!teamId) return { available: false };
    return fetchTeamStatsByTeamId(teamId, leagueId, season);
  } catch {
    return { available: false };
  }
}

// Fetch fixtures for a date (all leagues). Returns raw fixture data.
export async function fetchFootballFixturesByDate(
  dateIso: string,
): Promise<RawFixtures["response"]> {
  if (!hasApiSportsKey()) return [];
  try {
    const res = await getJson<RawFixtures>(
      `${BASE}/fixtures`,
      { date: dateIso },
      key(),
    );
    if (!res.ok || !Array.isArray(res.data?.response)) return [];
    return res.data.response;
  } catch {
    return [];
  }
}

// Fetch fixtures for a specific league + season.
export async function fetchFootballFixturesByLeague(
  leagueId: number,
  season: number,
): Promise<RawFixtures["response"]> {
  if (!hasApiSportsKey()) return [];
  try {
    const res = await getJson<RawFixtures>(
      `${BASE}/fixtures`,
      { league: leagueId, season },
      key(),
    );
    if (!res.ok || !Array.isArray(res.data?.response)) return [];
    return res.data.response;
  } catch {
    return [];
  }
}

// Pull API-Sports predictions for a fixture (useful as prior / form signal).
export async function fetchFootballPrediction(
  fixtureId: number,
): Promise<{ homePct: number | null; drawPct: number | null; awayPct: number | null }> {
  if (!hasApiSportsKey()) return { homePct: null, drawPct: null, awayPct: null };
  try {
    const res = await getJson<RawPrediction>(
      `${BASE}/predictions`,
      { fixture: fixtureId },
      key(),
    );
    const pred = res.ok ? res.data?.response?.[0]?.predictions?.percent : undefined;
    if (!pred) return { homePct: null, drawPct: null, awayPct: null };
    const parseP = (s?: string) => (s ? parseFloat(s.replace("%", "")) || null : null);
    return {
      homePct: parseP(pred.home),
      drawPct: parseP(pred.draw),
      awayPct: parseP(pred.away),
    };
  } catch {
    return { homePct: null, drawPct: null, awayPct: null };
  }
}

export type { RawFixtures };

// Determine if a league name suggests a friendly/exhibition match
export function isFriendlyLeague(leagueName: string | null): boolean {
  if (!leagueName) return false;
  const l = leagueName.toLowerCase();
  return l.includes("friendly") || l.includes("exhibition") || l.includes("test match");
}

// Get the season year for a given API-Sports league ID
export function seasonForLeague(leagueId: number): number {
  const info = SOCCER_LEAGUES.find((l) => l.id === leagueId);
  if (info) return info.season;
  // Fallback: current year
  return new Date().getFullYear();
}
