// False-grade reconciliation (v6.7.5). The v6.7.3 live tracker graded prop picks
// against games that had not started, crediting phantom wins to the bankroll.
// This module re-validates every graded prop pick on today's/yesterday's slate
// against the current MLB game status and unwinds any whose game is NOT final —
// reversing the exact bankroll delta, clearing the grade, and removing the
// permanent ledger entry (see unwindFalsePropGrade in gradedBook).
//
// Two entry points share the same per-pick logic:
//   • reconcileFalseGradesV675 — one-shot, run once on boot, guarded by a
//     system_state idempotency flag so a redeploy can't re-run it.
//   • validateGradesTick — the defensive ongoing check the live worker calls
//     every tick; logs a CRITICAL audit entry on each stray grade it heals.
//
// Best-effort: a game whose status can't be resolved is left ALONE (we never
// unwind on missing data — only on a positively-observed non-final status).

import {
  gradedPropPicksForDates,
  unwindFalsePropGrade,
  insertPropAudit,
  getSystemState,
  setSystemState,
  getEventTeamsForGame,
  type PropPickRow,
  type UnwindResult,
} from "../gradedBook";
import { fetchSchedule } from "../adapters/mlbStats";
import { resolveGamePk, type EventTeams } from "../sports/props/eventMapper";
import { DEFAULT_LIVE_DEPS } from "../sports/props/liveTracking";
import { gameStatusFrom, type GameStatus } from "../sports/props/liveTracking";
import { getOperatingDay } from "../sports/mlb/operatingDay";
import type { ScheduleGame } from "../adapters/mlbStats";

export const RECONCILIATION_FLAG = "reconciliation_v675_completed";
export const RECONCILIATION_AT = "reconciliation_v675_completed_at";

function log(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [reconcile-v675] ${message}`);
}

function yesterdayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface ReconcileDeps {
  candidates: (dates: string[]) => PropPickRow[];
  schedule: typeof fetchSchedule;
  fetchLiveFeed: typeof DEFAULT_LIVE_DEPS.fetchLiveFeed;
  unwind: typeof unwindFalsePropGrade;
}

const DEFAULT_DEPS: ReconcileDeps = {
  candidates: gradedPropPicksForDates,
  schedule: fetchSchedule,
  fetchLiveFeed: DEFAULT_LIVE_DEPS.fetchLiveFeed,
  unwind: unwindFalsePropGrade,
};

// Resolve the current coarse game status for a pick. Returns null when the game
// can't be resolved or the feed is unavailable — the caller must NOT unwind on
// null (only on a positively-observed non-final status).
async function statusForPick(
  pick: PropPickRow,
  schedule: ScheduleGame[],
  fetchLiveFeed: typeof DEFAULT_LIVE_DEPS.fetchLiveFeed,
  feedCache: Map<string, GameStatus | null>,
): Promise<GameStatus | null> {
  // The offer-side event_home/event_away are the authoritative two clubs for the
  // pick's game. prop_picks.team/opponent are unreliable (team is null unless
  // lineup resolution succeeded, and opponent can carry a stale constant), so
  // PREFER the offer teams whenever the offer row carries them; only fall back to
  // the pick's own fields when the offer lookup comes up empty.
  const offerTeams = getEventTeamsForGame(pick.game_id);
  const team = offerTeams.home ?? pick.team ?? null;
  const opponent = offerTeams.away ?? pick.opponent ?? null;
  const eventTeams: EventTeams = { team, opponent };
  const gamePk = resolveGamePk(eventTeams, schedule);
  if (!gamePk) return null;
  if (feedCache.has(gamePk)) return feedCache.get(gamePk) ?? null;
  const feed = await fetchLiveFeed(gamePk).catch(() => null);
  const status = feed ? gameStatusFrom(feed) : null;
  feedCache.set(gamePk, status);
  return status;
}

export interface ReconcileSummary {
  scanned: number;
  unwound: UnwindResult[];
  bankrollAdjustment: number; // total dollars subtracted back out
}

// Core pass: re-validate every graded pick over the given dates and unwind any
// whose game is positively NOT final. Shared by the one-shot and the tick check.
async function reconcilePass(dates: string[], deps: ReconcileDeps): Promise<ReconcileSummary> {
  const candidates = deps.candidates(dates);
  const unwound: UnwindResult[] = [];
  if (candidates.length === 0) return { scanned: 0, unwound, bankrollAdjustment: 0 };

  // Pull schedules for every date so resolveGamePk can find the game.
  const schedules = await Promise.all(dates.map((d) => deps.schedule(d).catch(() => [] as ScheduleGame[])));
  const schedule: ScheduleGame[] = schedules.flat();
  const feedCache = new Map<string, GameStatus | null>();

  let bankrollAdjustment = 0;
  for (const pick of candidates) {
    const status = await statusForPick(pick, schedule, deps.fetchLiveFeed, feedCache).catch(() => null);
    if (status === null) continue; // unresolved → leave alone
    if (status === "final") continue; // legitimately graded
    // Positively non-final (scheduled | live | unknown-but-resolved-game) → false grade.
    const result = deps.unwind(pick.pick_id, status);
    if (result) {
      unwound.push(result);
      bankrollAdjustment += result.originalPlDollars;
    }
  }
  return { scanned: candidates.length, unwound, bankrollAdjustment };
}

// One-shot, idempotent boot reconciliation. Runs the pass once, stamps the
// system_state flag, and never runs again (survives a redeploy). Returns the
// summary of what was unwound (empty when already completed).
export async function reconcileFalseGradesV675(
  today: string = getOperatingDay(),
  deps: ReconcileDeps = DEFAULT_DEPS,
): Promise<ReconcileSummary & { alreadyCompleted: boolean }> {
  if (getSystemState(RECONCILIATION_FLAG) === "true") {
    return { scanned: 0, unwound: [], bankrollAdjustment: 0, alreadyCompleted: true };
  }
  const dates = [today, yesterdayOf(today)];
  const summary = await reconcilePass(dates, deps).catch((err) => {
    log(`pass errored: ${(err as Error).message}`);
    return { scanned: 0, unwound: [], bankrollAdjustment: 0 } as ReconcileSummary;
  });

  if (summary.unwound.length > 0) {
    log(
      `unwound ${summary.unwound.length} false grade(s), bankroll adjusted -$${summary.bankrollAdjustment.toFixed(2)}`,
    );
  } else {
    log(`scanned ${summary.scanned} graded pick(s); none required unwinding`);
  }
  // Stamp the flag even when nothing was unwound: the one-shot is "done" either
  // way; the ongoing defensive check covers any future stray grade.
  setSystemState(RECONCILIATION_FLAG, "true");
  setSystemState(RECONCILIATION_AT, new Date().toISOString());
  return { ...summary, alreadyCompleted: false };
}

// Defensive ongoing check for the live worker's tick. Re-validates today's
// graded picks; on each stray grade it heals it writes a CRITICAL audit entry.
// Returns the count healed this tick.
export async function validateGradesTick(
  today: string = getOperatingDay(),
  deps: ReconcileDeps = DEFAULT_DEPS,
): Promise<number> {
  const dates = [today, yesterdayOf(today)];
  const summary = await reconcilePass(dates, deps).catch(() => ({
    scanned: 0,
    unwound: [],
    bankrollAdjustment: 0,
  } as ReconcileSummary));
  for (const u of summary.unwound) {
    insertPropAudit(
      u.pick_id,
      "critical",
      `CRITICAL stray_grade_healed gameStatus=${u.gameStatusAtUnwind} result=${u.originalResult} pl_dollars=${u.originalPlDollars}`,
    );
    log(`CRITICAL: healed stray grade ${u.pick_id} (status=${u.gameStatusAtUnwind})`);
  }
  return summary.unwound.length;
}

// Read the one-shot reconciliation outcome for the debug endpoint. The per-pick
// detail comes from the pick_audit rows the unwind wrote (reason prefix
// "false_grade_unwound_v675").
export function reconciliationFlag(): { ran: boolean; completedAt: string | null } {
  return {
    ran: getSystemState(RECONCILIATION_FLAG) === "true",
    completedAt: getSystemState(RECONCILIATION_AT),
  };
}
