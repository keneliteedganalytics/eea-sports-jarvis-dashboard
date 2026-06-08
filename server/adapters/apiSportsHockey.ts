// api-sports.io hockey adapter — NHL team stats (GPG / GAPG) and goalie
// availability. https://v1.hockey.api-sports.io  league=57 (NHL).
// Returns unavailable objects when API_SPORTS_KEY is unset so the slate falls
// back to league-average inputs.
//
// Goalie probable-starter data is fetched from the free NHL Web API
// (api-web.nhle.com) which is the authoritative source for confirmed
// starters. Falls back gracefully to {available: false} per team when the
// API is unreachable or starters are not yet announced.

import { getJson } from "./http";
import { nameToAbbr } from "../sports/nhl/teams";

const BASE = "https://v1.hockey.api-sports.io";
const NHL_WEB_BASE = "https://api-web.nhle.com/v1";
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
  firstName: string;
  lastName: string;
  available: boolean;
  svPct?: number | null;
  gaa?: number | null;
  gp?: number | null;
}

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

// ── API-Sports: team GPG/GAPG ────────────────────────────────────────────────

interface RawTeamSearchItem {
  id?: number;
  name?: string;
}
interface RawTeamSearch {
  response?: RawTeamSearchItem[];
}
interface RawTeamStats {
  response?: {
    goals?: {
      for?: { average?: { all?: string | number; total?: string | number } };
      against?: { average?: { all?: string | number; total?: string | number } };
    };
  };
}

async function resolveTeamId(teamFull: string, season: number): Promise<number | null> {
  // Try to find by search (which needs league + season for hockey)
  const res = await getJson<RawTeamSearch>(
    `${BASE}/teams`,
    { search: teamFull, league: NHL_LEAGUE, season },
    key(),
  );
  const first = res.ok ? res.data?.response?.[0] : undefined;
  return first?.id ?? null;
}

// Best-effort team GPG/GAPG. On any failure returns unavailable so the model
// uses league-average goals.
export async function fetchHockeyTeamStats(teamFull: string, season: number): Promise<HockeyTeamStats> {
  if (!hasApiSportsKey()) return { available: false };
  const teamId = await resolveTeamId(teamFull, season);
  if (!teamId) return { available: false };

  const res = await getJson<RawTeamStats>(
    `${BASE}/teams/statistics`,
    { team: teamId, league: NHL_LEAGUE, season },
    key(),
  );
  const g = res.ok ? res.data?.response?.goals : undefined;
  if (!g) return { available: false };

  // API-Sports hockey returns average.all (not average.total)
  const gpg = num(g.for?.average?.all ?? g.for?.average?.total);
  const gapg = num(g.against?.average?.all ?? g.against?.average?.total);
  if (gpg === null && gapg === null) return { available: false };
  return { available: true, gpg, gapg, xgfPct: null };
}

// ── NHL Web API: schedule + gamecenter goalie data ───────────────────────────
// The authoritative free source for probable/confirmed playoff starters.
// https://api-web.nhle.com/v1/schedule/{date}          → game IDs
// https://api-web.nhle.com/v1/gamecenter/{gameId}/landing → goalieComparison

interface NhlWebScheduleGame {
  id?: number;
  awayTeam?: { abbrev?: string };
  homeTeam?: { abbrev?: string };
}
interface NhlWebScheduleWeek {
  date?: string;
  games?: NhlWebScheduleGame[];
}
interface NhlWebSchedule {
  gameWeek?: NhlWebScheduleWeek[];
}

interface NhlGoalieLeader {
  playerId?: number;
  firstName?: { default?: string };
  lastName?: { default?: string };
  gamesPlayed?: number;
  savePctg?: number;
  gaa?: number;
  record?: string;
}
interface NhlGoalieTeam {
  leaders?: NhlGoalieLeader[];
}
interface NhlGoalieComparison {
  homeTeam?: NhlGoalieTeam;
  awayTeam?: NhlGoalieTeam;
}
interface NhlLanding {
  awayTeam?: { abbrev?: string };
  homeTeam?: { abbrev?: string };
  matchup?: {
    goalieComparison?: NhlGoalieComparison;
  };
}

function goalieFromLeader(
  teamAbbr: string,
  leader: NhlGoalieLeader | undefined,
): GoalieAvail {
  if (!leader || !leader.firstName?.default || !leader.lastName?.default) {
    return { teamAbbr, goalie: "TBD", firstName: "", lastName: "", available: false };
  }
  // Only mark available if they have real playoff stats (gamesPlayed > 0)
  const hasStats = typeof leader.gamesPlayed === "number" && leader.gamesPlayed > 0;
  return {
    teamAbbr,
    goalie: `${leader.firstName.default} ${leader.lastName.default}`,
    firstName: leader.firstName.default,
    lastName: leader.lastName.default,
    available: hasStats,
    svPct: hasStats ? (leader.savePctg ?? null) : null,
    gaa: hasStats ? (leader.gaa ?? null) : null,
    gp: hasStats ? (leader.gamesPlayed ?? null) : null,
  };
}

// Fetch probable/primary starters for all NHL games on a given date.
// Returns one GoalieAvail per team (keyed by tri-code). Falls back to empty
// list if the NHL Web API is unreachable or has no data for the date.
export async function fetchHockeyGoalies(dateStr: string): Promise<GoalieAvail[]> {
  // 1. Get the day's schedule to collect game IDs
  const schedRes = await getJson<NhlWebSchedule>(`${NHL_WEB_BASE}/schedule/${dateStr}`);
  if (!schedRes.ok || !schedRes.data?.gameWeek) return [];

  // Find the matching date block (API returns a week-range; find the exact date)
  const dayBlock = schedRes.data.gameWeek.find((w) => w.date === dateStr);
  const games = dayBlock?.games ?? [];
  if (games.length === 0) return [];

  const goalies: GoalieAvail[] = [];

  // 2. For each game, fetch the gamecenter landing for goalie comparison
  await Promise.all(
    games.map(async (game) => {
      if (!game.id) return;
      const landingRes = await getJson<NhlLanding>(
        `${NHL_WEB_BASE}/gamecenter/${game.id}/landing`,
      );
      if (!landingRes.ok || !landingRes.data) return;

      const landing = landingRes.data;
      const homeAbbr = landing.homeTeam?.abbrev ?? game.homeTeam?.abbrev ?? "";
      const awayAbbr = landing.awayTeam?.abbrev ?? game.awayTeam?.abbrev ?? "";

      const gc = landing.matchup?.goalieComparison;
      if (!gc) return;

      // leaders[0] is the primary (most games played) goalie for the team
      const homeLeader = gc.homeTeam?.leaders?.[0];
      const awayLeader = gc.awayTeam?.leaders?.[0];

      if (homeAbbr) goalies.push(goalieFromLeader(homeAbbr, homeLeader));
      if (awayAbbr) goalies.push(goalieFromLeader(awayAbbr, awayLeader));
    }),
  );

  void nameToAbbr; // keep import used
  return goalies;
}
