// MLB Stats API adapter — schedule, probable pitchers, and pitcher season
// stats. https://statsapi.mlb.com/api/v1 (no key required, but treated as
// best-effort: returns empty results on failure so the slate degrades softly).

import { getJson } from "./http";
import { computeFip, type PitcherStats } from "../sports/mlb/pitchers";
import { nameToAbbr } from "../sports/mlb/teams";
import type { TeamOffense } from "../sports/mlb/ratings";

const BASE = "https://statsapi.mlb.com/api/v1";

export interface ScheduleGame {
  gamePk: string;
  startIso: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  homeTeamId: number | null;
  awayTeamId: number | null;
  homePitcherId: number | null;
  awayPitcherId: number | null;
  homePitcher: string | null;
  awayPitcher: string | null;
  // Posted batting orders (player ids in 1..9 slot order), present only when the
  // schedule is hydrated with lineups and a lineup has been posted. Empty until
  // ~an hour before first pitch.
  homeBattingOrder: number[];
  awayBattingOrder: number[];
}

export interface FetchScheduleOpts {
  includeLineups?: boolean;
}

interface RawTeamNode {
  team?: { id?: number; name?: string };
  probablePitcher?: { id?: number; fullName?: string };
}
interface RawLineups {
  homePlayers?: { id?: number }[];
  awayPlayers?: { id?: number }[];
}
interface RawGame {
  gamePk: number;
  gameDate: string;
  venue?: { name?: string };
  teams?: { home?: RawTeamNode; away?: RawTeamNode };
  lineups?: RawLineups;
}
interface RawSchedule {
  dates?: { games?: RawGame[] }[];
}

function lineupIds(players: { id?: number }[] | undefined): number[] {
  if (!players) return [];
  const ids: number[] = [];
  for (const p of players) {
    if (typeof p.id === "number") ids.push(p.id);
  }
  return ids;
}

export async function fetchSchedule(
  dateStr: string,
  opts: FetchScheduleOpts = {},
): Promise<ScheduleGame[]> {
  const hydrate = opts.includeLineups
    ? "probablePitcher,venue,lineups"
    : "probablePitcher,venue";
  const res = await getJson<RawSchedule>(`${BASE}/schedule`, {
    sportId: 1,
    date: dateStr,
    hydrate,
  });
  if (!res.ok || !res.data?.dates) return [];

  const out: ScheduleGame[] = [];
  for (const d of res.data.dates) {
    for (const g of d.games ?? []) {
      const home = g.teams?.home;
      const away = g.teams?.away;
      const homeFull = home?.team?.name ?? "?";
      const awayFull = away?.team?.name ?? "?";
      out.push({
        gamePk: String(g.gamePk),
        startIso: g.gameDate,
        homeTeamFull: homeFull,
        awayTeamFull: awayFull,
        homeTeam: nameToAbbr(homeFull),
        awayTeam: nameToAbbr(awayFull),
        venue: g.venue?.name ?? "",
        homeTeamId: home?.team?.id ?? null,
        awayTeamId: away?.team?.id ?? null,
        homePitcherId: home?.probablePitcher?.id ?? null,
        awayPitcherId: away?.probablePitcher?.id ?? null,
        homePitcher: home?.probablePitcher?.fullName ?? null,
        awayPitcher: away?.probablePitcher?.fullName ?? null,
        homeBattingOrder: lineupIds(g.lineups?.homePlayers),
        awayBattingOrder: lineupIds(g.lineups?.awayPlayers),
      });
    }
  }
  return out;
}

interface RawStatSplit {
  stat?: {
    inningsPitched?: string;
    era?: string;
    gamesStarted?: number;
    homeRuns?: number;
    baseOnBalls?: number;
    strikeOuts?: number;
    whip?: string;
  };
}
interface RawPeopleStats {
  stats?: { splits?: RawStatSplit[] }[];
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Fetch current-season pitching line for a pitcher and classify it.
export async function fetchPitcherStats(
  pitcherId: number | null,
  name: string | null,
): Promise<PitcherStats> {
  const base: PitcherStats = {
    available: false,
    pitcher: name ?? "TBD",
    pitcherId: pitcherId ?? null,
    reason: pitcherId ? null : "no probable pitcher announced",
  };
  if (!pitcherId) return base;

  const res = await getJson<RawPeopleStats>(`${BASE}/people/${pitcherId}/stats`, {
    stats: "season",
    group: "pitching",
  });
  const split = res.ok ? res.data?.stats?.[0]?.splits?.[0]?.stat : undefined;
  if (!split) return { ...base, reason: "no season stats" };

  const ip = toNum(split.inningsPitched) ?? 0;
  const era = toNum(split.era);
  const fip = computeFip(ip, toNum(split.homeRuns), toNum(split.baseOnBalls), toNum(split.strikeOuts));

  return {
    available: true,
    pitcher: name ?? "TBD",
    pitcherId,
    ip,
    gs: toNum(split.gamesStarted),
    era,
    fip,
    whip: toNum(split.whip),
  };
}

interface RawHittingSplit {
  stat?: {
    runs?: number;
    gamesPlayed?: number;
    obp?: string;
    slg?: string;
    ops?: string;
    avg?: string;
  };
}
interface RawTeamStats {
  stats?: { splits?: RawHittingSplit[] }[];
}

// Fetch a team's current-season hitting line (runs/game + OPS) for the model's
// offense step. Empty/unavailable on any failure so the slate degrades softly.
export async function fetchTeamOffense(
  teamId: number | null,
  teamName: string | null,
): Promise<TeamOffense> {
  const base: TeamOffense = { available: false, team: teamName ?? undefined };
  if (!teamId) return base;

  const res = await getJson<RawTeamStats>(`${BASE}/teams/${teamId}/stats`, {
    stats: "season",
    group: "hitting",
    season: new Date().getUTCFullYear(),
  });
  const split = res.ok ? res.data?.stats?.[0]?.splits?.[0]?.stat : undefined;
  if (!split) return base;

  const runs = toNum(split.runs);
  const games = toNum(split.gamesPlayed);
  const rpg = runs !== null && games !== null && games > 0 ? runs / games : null;

  return {
    available: true,
    team: teamName ?? undefined,
    rpg,
    ops: toNum(split.ops),
    obp: toNum(split.obp),
    slg: toNum(split.slg),
  };
}
