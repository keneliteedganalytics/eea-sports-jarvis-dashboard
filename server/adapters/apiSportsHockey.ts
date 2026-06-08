// api-sports.io hockey adapter — NHL team stats (GPG / GAPG) and goalie
// availability. https://v1.hockey.api-sports.io  league=57 (NHL).
// Returns unavailable objects when API_SPORTS_KEY is unset so the slate falls
// back to league-average inputs.

import { getJson } from "./http";
import { nameToAbbr } from "../sports/nhl/teams";

const BASE = "https://v1.hockey.api-sports.io";
const NHL_LEAGUE = 57;

export interface HockeyTeamStats {
  available: boolean;
  gpg?: number | null; // goals for per game
  gapg?: number | null; // goals against per game
  xgfPct?: number | null;
}

export interface GoalieAvail {
  teamAbbr: string;
  goalie: string;
  available: boolean;
  svPct?: number | null;
}

export function hasApiSportsKey(): boolean {
  return Boolean(process.env.API_SPORTS_KEY);
}

function key(): Record<string, string> {
  return { "x-apisports-key": process.env.API_SPORTS_KEY as string };
}

interface RawTeamSearch {
  response?: { id?: number; name?: string }[];
}
interface RawTeamStats {
  response?: {
    goals?: {
      for?: { average?: { total?: string | number } };
      against?: { average?: { total?: string | number } };
    };
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function resolveTeamId(teamFull: string): Promise<number | null> {
  const res = await getJson<RawTeamSearch>(`${BASE}/teams`, { search: teamFull, league: NHL_LEAGUE }, key());
  const first = res.ok ? res.data?.response?.[0] : undefined;
  return first?.id ?? null;
}

// Best-effort team GPG/GAPG. On any failure returns unavailable so the model
// uses league-average goals.
export async function fetchHockeyTeamStats(teamFull: string, season: number): Promise<HockeyTeamStats> {
  if (!hasApiSportsKey()) return { available: false };
  const teamId = await resolveTeamId(teamFull);
  if (!teamId) return { available: false };

  const res = await getJson<RawTeamStats>(
    `${BASE}/teams/statistics`,
    { team: teamId, league: NHL_LEAGUE, season },
    key(),
  );
  const g = res.ok ? res.data?.response?.goals : undefined;
  if (!g) return { available: false };

  const gpg = num(g.for?.average?.total);
  const gapg = num(g.against?.average?.total);
  if (gpg === null && gapg === null) return { available: false };
  return { available: true, gpg, gapg, xgfPct: null };
}

// Starting-goalie availability for the day. The hockey plan does not expose a
// reliable probable-goalie feed, so we return [] (callers treat every goalie as
// unannounced, which the hard-pass guard handles against extreme lines).
export async function fetchHockeyGoalies(_dateStr: string): Promise<GoalieAvail[]> {
  // Reserved for a future probable-goalie source. Intentionally empty today.
  void nameToAbbr;
  return [];
}
