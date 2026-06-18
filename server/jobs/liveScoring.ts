// Live-scoring job. For a given date, reads every open (non-final, staked) pick
// from the graded book, fetches the matching sport's public ESPN scoreboard,
// matches each pick to its event, writes the live score + status, and — on the
// transition to a completed game — grades the pick exactly once.

import { fetchSportScoreboard, type EspnGame } from "../adapters/espnLive";
import { matchEvent } from "./teamMatch";
import {
  openPicksForDate,
  updateLive,
  settlePick,
  recordGradeLedger,
  getOpenF5PicksForDate,
  settleF5Pick,
  type GradedPick,
  type F5PickRow,
} from "../gradedBook";
import { gradeMoneyline, gradeSpread, gradeTotal, plUnits, type Result, type Side } from "../grading";
import { getJson } from "../adapters/http";
import { DISPLAY_TIMEZONE } from "../utils/timezone";

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
  // Append to the permanent history ledger + adjust the running bankroll. Runs
  // once per pending→final transition (openPicksForDate already excludes finals,
  // and recordGradeLedger is idempotent on pick_id for the bankroll side).
  recordGradeLedger(pick.id);
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
// every matching pick.
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
      games = await fetchSportScoreboard(sport, date);
    } catch (e) {
      console.error(`[liveScoring] ${sport} fetch threw for ${date}:`, e instanceof Error ? e.message : e);
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
    timeZone: DISPLAY_TIMEZONE,
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

// ── v6.10: F5 grading ─────────────────────────────────────────────
// Fetch the MLB Stats API live linescore. When the bottom of the 5th inning
// is complete (innings[4].isComplete === true, 0-indexed), sum innings 1-5
// for each side and grade the F5 pick.

interface MlbLinescore {
  innings?: Array<{
    num?: number;
    home?: { runs?: number };
    away?: { runs?: number };
    isComplete?: boolean;
  }>;
  currentInning?: number;
  currentInningState?: string;
}

async function fetchMlbLinescore(gamePk: string): Promise<MlbLinescore | null> {
  const res = await getJson<{ liveData?: { linescore?: MlbLinescore } }>(
    `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
    { timecode: "" }, // no timecode = latest
  );
  if (!res.ok) return null;
  return res.data?.liveData?.linescore ?? null;
}

// Sum runs for innings 1-5 from the linescore array (0-indexed [0..4]).
export function sumF5Runs(
  innings: MlbLinescore["innings"],
  side: "home" | "away",
): number {
  if (!innings) return 0;
  let total = 0;
  for (let i = 0; i < 5 && i < innings.length; i++) {
    total += innings[i]?.[side]?.runs ?? 0;
  }
  return total;
}

// True when the bottom of the 5th is complete (inning index 4, isComplete).
export function isFifthInningComplete(innings: MlbLinescore["innings"] | undefined): boolean {
  if (!innings || innings.length < 5) return false;
  const fifth = innings[4];
  // The 5th inning is fully complete when isComplete is true AND both halves have been played.
  // MLB Stats API sets isComplete=true after the bottom of the inning.
  return fifth?.isComplete === true;
}

// Grade a single F5 pick row against actual 5-inning run totals.
export function gradeF5Pick(pick: F5PickRow, homeRuns: number, awayRuns: number): string {
  const side = pick.pickSide;
  let result: string;
  if (pick.market === "h2h_f5") {
    if (side === "home") result = homeRuns > awayRuns ? "W" : homeRuns < awayRuns ? "L" : "P";
    else result = awayRuns > homeRuns ? "W" : awayRuns < homeRuns ? "L" : "P";
  } else if (pick.market === "totals_f5" && pick.line !== null) {
    const total = homeRuns + awayRuns;
    if (side === "over") result = total > pick.line ? "W" : total < pick.line ? "L" : "P";
    else result = total < pick.line ? "W" : total > pick.line ? "L" : "P";
  } else {
    result = "P"; // unrecognized — push
  }
  const price = pick.price ?? -110;
  const units = 1; // F5 picks are 1u flat for now
  const pl = result === "W" ? (price > 0 ? units * price / 100 : units * 100 / Math.abs(price))
            : result === "L" ? -units : 0;
  settleF5Pick(pick.id, homeRuns, awayRuns, result, Math.round(pl * 100) / 100);
  return result;
}

// Poll open F5 picks for a date, fetch each game's live linescore, and grade
// when the 5th inning is complete. gamePk lookup: gameId is the Odds API event
// id which is NOT a gamePk — we match by team names from the F5 row.
// For simplicity, we re-fetch the MLB schedule for the date each poll cycle.
export async function pollF5Grading(date: string): Promise<{ graded: number }> {
  const open = getOpenF5PicksForDate(date);
  if (open.length === 0) return { graded: 0 };

  // Import schedule fetcher lazily to avoid circular deps
  const { fetchSchedule } = await import("../adapters/mlbStats");
  const schedule = await fetchSchedule(date);

  let graded = 0;
  const seenGameId = new Set<string>();

  // Because eventId ≠ gamePk in general, we try matching by gamePk first
  // (The Odds API sometimes uses the gamePk as event id) and fall back to
  // checking all schedule games.
  for (const sched of schedule) {
    const openForGame = open.filter((p) =>
      !seenGameId.has(`${p.gameId}:done`) && p.gameId === sched.gamePk,
    );
    if (openForGame.length === 0) continue;

    try {
      const ls = await fetchMlbLinescore(sched.gamePk);
      if (!ls || !isFifthInningComplete(ls.innings)) continue;

      const homeRuns = sumF5Runs(ls.innings, "home");
      const awayRuns = sumF5Runs(ls.innings, "away");

      for (const pick of openForGame) {
        gradeF5Pick(pick, homeRuns, awayRuns);
        seenGameId.add(`${pick.gameId}:done`);
        graded++;
      }
    } catch (e) {
      console.error(`[liveScoring] F5 grade error for ${sched.gamePk}:`, e instanceof Error ? e.message : e);
    }
  }

  return { graded };
}

export function startLiveScoring(): void {
  if (timer) return;
  void pollNow();
  timer = setInterval(() => void pollNow(), POLL_INTERVAL_MS);
  // Don't keep the event loop alive solely for the poller.
  timer.unref?.();
}
