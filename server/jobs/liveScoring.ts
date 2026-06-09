// Live-scoring job. For a given date, reads every open (non-final, staked) pick
// from the graded book, fetches the matching sport's public ESPN scoreboard,
// matches each pick to its event, writes the live score + status, and — on the
// transition to a completed game — grades the pick exactly once.

import { fetchSportScoreboard, fetchSoccerScoreboard, type EspnGame } from "../adapters/espnLive";
import { matchEvent } from "./teamMatch";
import {
  openPicksForDate,
  updateLive,
  settlePick,
  type GradedPick,
} from "../gradedBook";
import { gradeMoneyline, gradeSpread, gradeTotal, plUnits, type Result, type Side } from "../grading";

export interface PollSummary {
  date: string;
  scanned: number;
  updated: number;
  graded: number;
}

// Grade a single pick against its final score and persist the result. Returns
// the result letter so callers/tests can assert. Only ML/spread/total markets
// exist on these picks; pickType is "ML" today but spread/total are supported.
export function gradePick(pick: GradedPick, finalAwayScore: number, finalHomeScore: number): Result {
  const side = pick.pickSide as Side;
  let result: Result;
  const type = (pick.pickType ?? "ML").toUpperCase();
  if (type === "SPREAD" && pick.pickLine !== null) {
    result = gradeSpread(side, pick.pickLine, finalAwayScore, finalHomeScore);
  } else if (type === "TOTAL" && pick.pickLine !== null) {
    const overUnder = pick.pickSide === "over" || pick.pickSide === "home" ? "over" : "under";
    result = gradeTotal(overUnder, pick.pickLine, finalAwayScore, finalHomeScore);
  } else {
    result = gradeMoneyline(side, finalAwayScore, finalHomeScore);
  }
  const pl = plUnits(result, pick.units, pick.pickMl);
  settlePick(pick.id, {
    finalAwayScore,
    finalHomeScore,
    result,
    pl,
    clvPct: pick.clvPct ?? null,
    liveStatusDetail: "Final",
  });
  return result;
}

// Apply a sport's fetched events to its open picks: grade completed games,
// write live scores otherwise. Pure of network I/O so it's directly testable.
export function applyEventsToPicks(picks: GradedPick[], games: EspnGame[], summary: PollSummary): void {
  for (const pick of picks) {
    const ev = matchEvent(pick, games);
    if (!ev) continue;
    const away = ev.away.score;
    const home = ev.home.score;

    if (ev.completed && away !== null && home !== null) {
      // Only grade a pick once — a row already final is skipped upstream by
      // openPicksForDate, so reaching here means a real pending→final move.
      gradePick(pick, away, home);
      summary.graded++;
      summary.updated++;
    } else {
      updateLive(pick.id, {
        status: ev.state === "in" ? "in_progress" : "pending",
        liveAwayScore: away,
        liveHomeScore: home,
        liveStatusDetail: ev.statusDetail || null,
      });
      summary.updated++;
    }
  }
}

// Group open picks by sport, fetch each sport's scoreboard once, then update
// every matching pick. Soccer unions the major league scoreboards.
export async function pollEspnAndUpdate(date: string): Promise<PollSummary> {
  const open = openPicksForDate(date);
  const summary: PollSummary = { date, scanned: open.length, updated: 0, graded: 0 };
  if (open.length === 0) return summary;

  const bySport = new Map<string, GradedPick[]>();
  for (const p of open) {
    const arr = bySport.get(p.sport) ?? [];
    arr.push(p);
    bySport.set(p.sport, arr);
  }

  for (const [sport, picks] of bySport) {
    let games: EspnGame[] = [];
    try {
      games = sport === "soccer" ? await fetchSoccerScoreboard(date) : await fetchSportScoreboard(sport, date);
    } catch {
      games = [];
    }
    if (games.length === 0) continue;
    applyEventsToPicks(picks, games, summary);
  }

  return summary;
}

const POLL_INTERVAL_MS = 15 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

function todayEt(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function yesterdayEt(now: Date = new Date()): string {
  return todayEt(new Date(now.getTime() - 86_400_000));
}

// Run one poll over today + yesterday (yesterday catches late finals after the
// ET date rolls over). Never throws.
async function pollNow(): Promise<void> {
  try {
    await pollEspnAndUpdate(todayEt());
    await pollEspnAndUpdate(yesterdayEt());
  } catch (e) {
    console.error("liveScoring poll failed:", e instanceof Error ? e.message : e);
  }
}

export function startLiveScoring(): void {
  if (timer) return;
  void pollNow();
  timer = setInterval(() => void pollNow(), POLL_INTERVAL_MS);
}
