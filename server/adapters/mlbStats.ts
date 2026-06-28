// MLB Stats API adapter — schedule, probable pitchers, and pitcher season
// stats. https://statsapi.mlb.com/api/v1 (no key required, but treated as
// best-effort: returns empty results on failure so the slate degrades softly).

import { getJson } from "./http";
import { computeFip, type PitcherStats } from "../sports/mlb/pitchers";
import { nameToAbbr } from "../sports/mlb/teams";
import type { TeamOffense } from "../sports/mlb/ratings";
import { staticDivisionMap } from "../sports/mlb/divisions";
import type { SeriesContext, Last18Record } from "../sports/mlb/hatfieldRules";

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
  // v6.13.2: series position (Rule 4). seriesGameNumber is 1-based; gamesInSeries
  // is 3 or 4 for a normal series. Null when the schedule omits them.
  seriesGameNumber: number | null;
  gamesInSeries: number | null;
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
  seriesGameNumber?: number;
  gamesInSeries?: number;
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
        seriesGameNumber: typeof g.seriesGameNumber === "number" ? g.seriesGameNumber : null,
        gamesInSeries: typeof g.gamesInSeries === "number" ? g.gamesInSeries : null,
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

// ── v6.13.2: Rule 4 (sweep-avoidance) + Rule 6 (last-18 trend) live feeds ─────
// Every function here is best-effort: any upstream failure degrades to the
// static division map / null context / null record, so Rules 4 & 6 stay no-ops
// and the slate reproduces v6.13.1 output exactly.

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDate(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ── Division map (teamId → divisionId), 24h cached ───────────────────────────
interface RawTeamsResponse {
  teams?: { id?: number; division?: { id?: number } }[];
}

let divisionCache: { at: number; season: number; map: Map<number, number> } | null = null;

export async function fetchDivisionMap(
  season: number = new Date().getUTCFullYear(),
): Promise<Map<number, number>> {
  if (
    divisionCache &&
    divisionCache.season === season &&
    Date.now() - divisionCache.at < DAY_MS
  ) {
    return divisionCache.map;
  }
  const res = await getJson<RawTeamsResponse>(`${BASE}/teams`, { sportId: 1, season });
  const map = new Map<number, number>();
  if (res.ok && res.data?.teams) {
    for (const t of res.data.teams) {
      if (typeof t.id === "number" && typeof t.division?.id === "number") {
        map.set(t.id, t.division.id);
      }
    }
  }
  // Fall back to the verified static alignment if the live pull came back empty.
  const finalMap = map.size > 0 ? map : staticDivisionMap();
  divisionCache = { at: Date.now(), season, map: finalMap };
  return finalMap;
}

// ── YTD run differential (teamId → runsScored - runsAllowed), 6h cached ──────
interface RawStandings {
  records?: {
    teamRecords?: {
      team?: { id?: number };
      runsScored?: number;
      runsAllowed?: number;
      runDifferential?: number;
    }[];
  }[];
}

const RUNDIFF_TTL_MS = 6 * 60 * 60 * 1000;
let runDiffCache: { at: number; season: number; map: Map<number, number> } | null = null;

export async function fetchTeamRunDiffMap(
  season: number = new Date().getUTCFullYear(),
): Promise<Map<number, number>> {
  if (
    runDiffCache &&
    runDiffCache.season === season &&
    Date.now() - runDiffCache.at < RUNDIFF_TTL_MS
  ) {
    return runDiffCache.map;
  }
  const res = await getJson<RawStandings>(`${BASE}/standings`, {
    leagueId: "103,104",
    season,
  });
  const map = new Map<number, number>();
  if (res.ok && res.data?.records) {
    for (const rec of res.data.records) {
      for (const tr of rec.teamRecords ?? []) {
        const id = tr.team?.id;
        if (typeof id !== "number") continue;
        const diff =
          typeof tr.runDifferential === "number"
            ? tr.runDifferential
            : (toNum(tr.runsScored) ?? 0) - (toNum(tr.runsAllowed) ?? 0);
        map.set(id, diff);
      }
    }
  }
  runDiffCache = { at: Date.now(), season, map };
  return map;
}

// ── Final-score schedule rows for a team over a date window ───────────────────
interface RawScoreTeamNode {
  team?: { id?: number };
  score?: number;
  isWinner?: boolean;
}
interface RawScoreGame {
  gamePk?: number;
  officialDate?: string;
  gameDate?: string;
  gameType?: string;
  status?: { detailedState?: string; abstractGameState?: string };
  teams?: { home?: RawScoreTeamNode; away?: RawScoreTeamNode };
}
interface RawScoreSchedule {
  dates?: { games?: RawScoreGame[] }[];
}

interface FinalGame {
  date: string;
  homeId: number | null;
  awayId: number | null;
  homeScore: number | null;
  awayScore: number | null;
  winnerId: number | null; // home or away team id, null if undetermined
}

async function fetchTeamFinals(
  teamId: number,
  startDate: string,
  endDate: string,
): Promise<FinalGame[]> {
  const res = await getJson<RawScoreSchedule>(`${BASE}/schedule`, {
    sportId: 1,
    teamId,
    startDate,
    endDate,
    hydrate: "team",
  });
  const out: FinalGame[] = [];
  if (!res.ok || !res.data?.dates) return out;
  for (const d of res.data.dates) {
    for (const g of d.games ?? []) {
      if (g.gameType !== "R") continue;
      const state = g.status?.detailedState ?? g.status?.abstractGameState ?? "";
      if (state !== "Final") continue;
      const hs = toNum(g.teams?.home?.score);
      const as = toNum(g.teams?.away?.score);
      const homeId = g.teams?.home?.team?.id ?? null;
      const awayId = g.teams?.away?.team?.id ?? null;
      let winnerId: number | null = null;
      if (hs !== null && as !== null && homeId !== null && awayId !== null) {
        winnerId = hs > as ? homeId : as > hs ? awayId : null;
      }
      out.push({
        date: g.officialDate ?? (g.gameDate ?? "").slice(0, 10),
        homeId,
        awayId,
        homeScore: hs,
        awayScore: as,
        winnerId,
      });
    }
  }
  out.sort((x, y) => x.date.localeCompare(y.date));
  return out;
}

// ── Series context for a game (Rule 4), per-gamePk cached for one slate ──────
// Maps the live facts into the existing SeriesContext shape consumed by
// computeSweepSpot. Returns null only on a total failure to resolve the game's
// series position; otherwise returns a context whose unmet conditions simply
// leave the spot un-fired (a clean no-op).
const seriesCtxCache = new Map<string, { at: number; ctx: SeriesContext | null }>();
const SERIES_TTL_MS = 60 * 60 * 1000; // 1h — series state changes at most daily.

export async function fetchSeriesContext(
  gamePk: string | number,
  awayTeamId: number | null,
  homeTeamId: number | null,
  gameDate: string,
): Promise<SeriesContext | null> {
  const key = String(gamePk);
  const hit = seriesCtxCache.get(key);
  if (hit && Date.now() - hit.at < SERIES_TTL_MS) return hit.ctx;

  const ctx = await resolveSeriesContext(gamePk, awayTeamId, homeTeamId, gameDate);
  seriesCtxCache.set(key, { at: Date.now(), ctx });
  return ctx;
}

async function resolveSeriesContext(
  gamePk: string | number,
  awayTeamId: number | null,
  homeTeamId: number | null,
  gameDate: string,
): Promise<SeriesContext | null> {
  if (homeTeamId === null || awayTeamId === null) return null;

  // Series position from the day's schedule entry.
  const sched = await fetchSchedule(gameDate);
  const me = sched.find((s) => String(s.gamePk) === String(gamePk));
  const gameNumberInSeries = me?.seriesGameNumber ?? 0;
  const seriesLength = me?.gamesInSeries ?? 0;

  const divMap = await fetchDivisionMap(new Date(`${gameDate}T00:00:00Z`).getUTCFullYear());
  const homeDiv = divMap.get(homeTeamId);
  const awayDiv = divMap.get(awayTeamId);
  const sameDivision = homeDiv !== undefined && awayDiv !== undefined && homeDiv === awayDiv;

  // Prior two results of THIS series: the home team's finals vs this opponent in
  // the 5 days ending the day before the game.
  const start = shiftDate(gameDate, -5);
  const end = shiftDate(gameDate, -1);
  const finals = await fetchTeamFinals(homeTeamId, start, end);
  const seriesPrior = finals.filter(
    (g) =>
      (g.homeId === homeTeamId && g.awayId === awayTeamId) ||
      (g.homeId === awayTeamId && g.awayId === homeTeamId),
  );
  // The two most recent meetings = games 1 and 2 of the current series.
  const lastTwo = seriesPrior.slice(-2);

  let trailingSide: "home" | "away" | null = null;
  let trailingTeamLostFirstTwo = false;
  if (
    lastTwo.length === 2 &&
    lastTwo[0].winnerId !== null &&
    lastTwo[1].winnerId === lastTwo[0].winnerId
  ) {
    const leaderId = lastTwo[0].winnerId;
    const trailingId = leaderId === homeTeamId ? awayTeamId : homeTeamId;
    trailingTeamLostFirstTwo = true;
    trailingSide = trailingId === homeTeamId ? "home" : "away";
  }

  let trailingTeamPositiveRunDiff = false;
  if (trailingSide) {
    const trailingId = trailingSide === "home" ? homeTeamId : awayTeamId;
    const runDiff = await fetchTeamRunDiffMap(
      new Date(`${gameDate}T00:00:00Z`).getUTCFullYear(),
    );
    trailingTeamPositiveRunDiff = (runDiff.get(trailingId) ?? 0) > 0;
  }

  return {
    sameDivision,
    seriesLength,
    gameNumberInSeries,
    trailingTeamLostFirstTwo,
    trailingTeamPositiveRunDiff,
    trailingSide,
  };
}

// ── Last-18 ML record split by venue (Rule 6), 4h cached ─────────────────────
// Pulls the team's regular-season finals back to season start, splits home/away,
// takes the most recent 18 of each, and computes win pct. Early season uses what
// is available; a split with no games yields null (no-op).
const last18Cache = new Map<string, { at: number; rec: Last18Record }>();
const LAST18_TTL_MS = 4 * 60 * 60 * 1000;

export async function fetchLast18MLRecord(
  teamId: number | null,
  asOfDate: string,
  season: number = new Date().getUTCFullYear(),
): Promise<Last18Record | null> {
  if (teamId === null) return null;
  const key = `${teamId}:${asOfDate}`;
  const hit = last18Cache.get(key);
  if (hit && Date.now() - hit.at < LAST18_TTL_MS) return hit.rec;

  const start = `${season}-03-01`;
  const end = shiftDate(asOfDate, -1); // completed games only
  const finals = await fetchTeamFinals(teamId, start, end);

  const homeGames = finals.filter((g) => g.homeId === teamId);
  const awayGames = finals.filter((g) => g.awayId === teamId);

  const winPct = (games: FinalGame[]): number | null => {
    const last = games.slice(-18);
    if (last.length === 0) return null;
    let wins = 0;
    let decided = 0;
    for (const g of last) {
      if (g.winnerId === null) continue;
      decided++;
      if (g.winnerId === teamId) wins++;
    }
    if (decided === 0) return null;
    return wins / decided;
  };

  const rec: Last18Record = {
    homeWinPct: winPct(homeGames),
    awayWinPct: winPct(awayGames),
  };
  last18Cache.set(key, { at: Date.now(), rec });
  return rec;
}

// Test hooks — clear the in-process caches.
export function _clearMlbStatsCaches(): void {
  divisionCache = null;
  runDiffCache = null;
  seriesCtxCache.clear();
  last18Cache.clear();
}
