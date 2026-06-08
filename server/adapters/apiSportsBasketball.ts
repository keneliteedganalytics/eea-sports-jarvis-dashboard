// api-sports.io basketball adapter — NBA team efficiency (ORtg/DRtg/pace).
// https://v1.basketball.api-sports.io  league=12 (NBA), season "2025-2026".
// balldontlie is a secondary source for schedule/team identity. Returns
// unavailable objects when keys are unset so the model uses league averages.

import { getJson } from "./http";
import type { TeamHoopStats } from "../sports/nba/model";

const BASE = "https://v1.basketball.api-sports.io";
const NBA_LEAGUE = 12;

export function hasApiSportsKey(): boolean {
  return Boolean(process.env.API_SPORTS_KEY);
}
export function hasBalldontlieKey(): boolean {
  return Boolean(process.env.BALLDONTLIE_API_KEY);
}

function key(): Record<string, string> {
  return { "x-apisports-key": process.env.API_SPORTS_KEY as string };
}

interface RawTeamSearch {
  response?: { id?: number; name?: string }[];
}
interface RawTeamStats {
  response?: {
    points?: {
      for?: { average?: { all?: string | number } };
      against?: { average?: { all?: string | number } };
    };
    games?: { played?: { all?: number } };
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function resolveTeamId(teamFull: string): Promise<number | null> {
  const res = await getJson<RawTeamSearch>(`${BASE}/teams`, { search: teamFull, league: NBA_LEAGUE }, key());
  const first = res.ok ? res.data?.response?.[0] : undefined;
  return first?.id ?? null;
}

// Best-effort team efficiency. The free plan exposes points-per-game rather than
// possession-normalized ratings, so we approximate ORtg/DRtg from PPG at a
// league pace and leave pace itself for the model's league default when absent.
export async function fetchHoopTeamStats(teamFull: string, season: string): Promise<TeamHoopStats> {
  if (!hasApiSportsKey()) return { available: false };
  const teamId = await resolveTeamId(teamFull);
  if (!teamId) return { available: false };

  const res = await getJson<RawTeamStats>(
    `${BASE}/teams/statistics`,
    { team: teamId, league: NBA_LEAGUE, season },
    key(),
  );
  const pts = res.ok ? res.data?.response?.points : undefined;
  if (!pts) return { available: false };

  const ppgFor = num(pts.for?.average?.all);
  const ppgAgainst = num(pts.against?.average?.all);
  if (ppgFor === null && ppgAgainst === null) return { available: false };

  // PPG → rating per 100 possessions at league pace (≈99.5). Coarse but keeps
  // the possession model honest until a true-ratings feed is wired.
  const LG_PACE = 99.5;
  const ortg = ppgFor !== null ? (ppgFor / LG_PACE) * 100 : null;
  const drtg = ppgAgainst !== null ? (ppgAgainst / LG_PACE) * 100 : null;
  return { available: true, ortg, drtg, pace: null };
}
