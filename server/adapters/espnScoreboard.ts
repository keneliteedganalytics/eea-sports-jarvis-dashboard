// ESPN scoreboard adapter — final scores for outcome settlement and probable
// pitcher cross-check. https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard
// No key required; best-effort (returns [] on failure).

import { getJson } from "./http";
import { nameToAbbr } from "../sports/mlb/teams";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";

export interface ScoreboardGame {
  eventId: string;
  startIso: string;
  state: "pre" | "in" | "post";
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  completed: boolean;
}

interface RawCompetitor {
  homeAway: "home" | "away";
  score?: string;
  team?: { displayName?: string };
}
interface RawCompetition {
  competitors?: RawCompetitor[];
  status?: { type?: { state?: string; completed?: boolean } };
}
interface RawEvent {
  id: string;
  date: string;
  competitions?: RawCompetition[];
}
interface RawScoreboard {
  events?: RawEvent[];
}

export async function fetchScoreboard(dateStr: string): Promise<ScoreboardGame[]> {
  // ESPN expects YYYYMMDD
  const ymd = dateStr.replace(/-/g, "");
  const res = await getJson<RawScoreboard>(BASE, { dates: ymd });
  if (!res.ok || !res.data?.events) return [];

  const out: ScoreboardGame[] = [];
  for (const ev of res.data.events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    const state = (comp.status?.type?.state ?? "pre") as ScoreboardGame["state"];
    out.push({
      eventId: ev.id,
      startIso: ev.date,
      state,
      homeTeam: nameToAbbr(home?.team?.displayName ?? "?"),
      awayTeam: nameToAbbr(away?.team?.displayName ?? "?"),
      homeScore: home?.score !== undefined ? Number(home.score) : null,
      awayScore: away?.score !== undefined ? Number(away.score) : null,
      completed: Boolean(comp.status?.type?.completed),
    });
  }
  return out;
}
