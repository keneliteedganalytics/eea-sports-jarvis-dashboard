// Multi-sport ESPN public scoreboard reader. Fetches the public scoreboard for a
// sport + date and parses each event into a normalized shape (abbreviations,
// display names, scores, status). No key required. Used by the live-scoring job
// to attach live/final scores to picks and grade them.

import { getJson } from "./http";

export type EventState = "pre" | "in" | "post";

export interface EspnCompetitor {
  side: "home" | "away";
  abbreviation: string;
  displayName: string;
  score: number | null;
}

export interface EspnGame {
  eventId: string;
  startIso: string;
  state: EventState;
  completed: boolean;
  statusDetail: string;
  home: EspnCompetitor;
  away: EspnCompetitor;
}

interface RawCompetitor {
  homeAway?: "home" | "away";
  score?: string;
  team?: { abbreviation?: string; displayName?: string };
}
interface RawStatusType {
  name?: string;
  state?: string;
  completed?: boolean;
  shortDetail?: string;
  detail?: string;
}
interface RawCompetition {
  competitors?: RawCompetitor[];
  status?: { type?: RawStatusType };
}
interface RawEvent {
  id: string;
  date: string;
  competitions?: RawCompetition[];
}
interface RawScoreboard {
  events?: RawEvent[];
}

// ESPN sport path per our sport key. Soccer needs a league code in the path.
const SPORT_PATH: Record<string, string> = {
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
  nba: "basketball/nba",
};

// Soccer league codes we try, in order, when a pick doesn't carry a league.
export const SOCCER_LEAGUES = [
  "fifa.world",
  "eng.1",
  "esp.1",
  "ita.1",
  "ger.1",
  "fra.1",
  "usa.1",
  "uefa.champions",
];

function scoreboardUrl(sportPath: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/scoreboard`;
}

// Map ESPN's status.type.name → our coarse state. completed is authoritative
// for the post transition.
function stateFromType(type: RawStatusType | undefined): { state: EventState; completed: boolean; detail: string } {
  const name = (type?.name ?? "").toUpperCase();
  const completed = Boolean(type?.completed) || name === "STATUS_FINAL";
  const state: EventState = completed
    ? "post"
    : name === "STATUS_IN_PROGRESS" || name === "STATUS_HALFTIME" || (type?.state === "in")
      ? "in"
      : "pre";
  const detail = type?.shortDetail ?? type?.detail ?? "";
  return { state, completed, detail };
}

export function parseEspnEvent(ev: RawEvent): EspnGame | null {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const rawHome = comp.competitors?.find((c) => c.homeAway === "home");
  const rawAway = comp.competitors?.find((c) => c.homeAway === "away");
  if (!rawHome || !rawAway) return null;
  const { state, completed, detail } = stateFromType(comp.status?.type);

  const toCompetitor = (c: RawCompetitor, side: "home" | "away"): EspnCompetitor => ({
    side,
    abbreviation: (c.team?.abbreviation ?? "").toUpperCase(),
    displayName: c.team?.displayName ?? "",
    score: c.score !== undefined && c.score !== "" ? Number(c.score) : null,
  });

  return {
    eventId: ev.id,
    startIso: ev.date,
    state,
    completed,
    statusDetail: detail,
    home: toCompetitor(rawHome, "home"),
    away: toCompetitor(rawAway, "away"),
  };
}

function parseScoreboard(raw: RawScoreboard | null): EspnGame[] {
  if (!raw?.events) return [];
  const out: EspnGame[] = [];
  for (const ev of raw.events) {
    const g = parseEspnEvent(ev);
    if (g) out.push(g);
  }
  return out;
}

// Fetch the scoreboard for a North-American sport (mlb/nhl/nba) on a date.
export async function fetchSportScoreboard(sport: string, dateStr: string): Promise<EspnGame[]> {
  const sportPath = SPORT_PATH[sport];
  if (!sportPath) return [];
  const ymd = dateStr.replace(/-/g, "");
  const res = await getJson<RawScoreboard>(scoreboardUrl(sportPath), { dates: ymd });
  return res.ok ? parseScoreboard(res.data) : [];
}

// Fetch soccer across the configured league codes (or a single given league),
// merging events. Soccer has no single national scoreboard, so we union the
// major leagues; duplicate eventIds are de-duped.
export async function fetchSoccerScoreboard(dateStr: string, leagues: string[] = SOCCER_LEAGUES): Promise<EspnGame[]> {
  const ymd = dateStr.replace(/-/g, "");
  const seen = new Set<string>();
  const out: EspnGame[] = [];
  for (const code of leagues) {
    const res = await getJson<RawScoreboard>(scoreboardUrl(`soccer/${code}`), { dates: ymd });
    if (!res.ok) continue;
    for (const g of parseScoreboard(res.data)) {
      if (seen.has(g.eventId)) continue;
      seen.add(g.eventId);
      out.push(g);
    }
  }
  return out;
}
