// MLB Stats API adapter — schedule, probable pitchers, and pitcher season
// stats. https://statsapi.mlb.com/api/v1 (no key required, but treated as
// best-effort: returns empty results on failure so the slate degrades softly).

import { getJson } from "./http";
import { computeFip, type PitcherStats } from "../sports/mlb/pitchers";
import { nameToAbbr } from "../sports/mlb/teams";

const BASE = "https://statsapi.mlb.com/api/v1";

export interface ScheduleGame {
  gamePk: string;
  startIso: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  homePitcherId: number | null;
  awayPitcherId: number | null;
  homePitcher: string | null;
  awayPitcher: string | null;
}

interface RawTeamNode {
  team?: { name?: string };
  probablePitcher?: { id?: number; fullName?: string };
}
interface RawGame {
  gamePk: number;
  gameDate: string;
  venue?: { name?: string };
  teams?: { home?: RawTeamNode; away?: RawTeamNode };
}
interface RawSchedule {
  dates?: { games?: RawGame[] }[];
}

export async function fetchSchedule(dateStr: string): Promise<ScheduleGame[]> {
  const res = await getJson<RawSchedule>(`${BASE}/schedule`, {
    sportId: 1,
    date: dateStr,
    hydrate: "probablePitcher,venue",
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
        homePitcherId: home?.probablePitcher?.id ?? null,
        awayPitcherId: away?.probablePitcher?.id ?? null,
        homePitcher: home?.probablePitcher?.fullName ?? null,
        awayPitcher: away?.probablePitcher?.fullName ?? null,
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
