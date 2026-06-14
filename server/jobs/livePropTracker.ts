// Live prop tracker worker (v6.7.3). Every 60 seconds — and once on boot — it
// recomputes the in-game disposition of every active prop pick on today's slate
// and writes the state to prop_picks.live_state so the board can turn a card
// green (clearing), red (busted), or mark it PAID. When a pick's game goes final
// it grades the pick (settle + bankroll) exactly once, so the running bankroll
// reflects prop results in real time.
//
// Best-effort + crash-safe: every step is void+catch guarded and this module
// never imports ../index (which would boot the HTTP server on import).

import {
  activePropPicksForDate,
  updatePropPickLiveState,
  settlePropPickWithBankroll,
  getEventTeamsForGame,
  healPassStakes,
  type PropPickRow,
} from "../gradedBook";
import { fetchSchedule } from "../adapters/mlbStats";
import { resolveMlbPlayerId } from "../sports/props/playerResolver";
import { gradePropResult } from "../sports/props/gradeProp";
import { plUnits } from "../grading";
import {
  computeLiveTracking,
  DEFAULT_LIVE_DEPS,
  type LiveTracking,
  type TrackedProp,
} from "../sports/props/liveTracking";
import { getOperatingDay } from "../sports/mlb/operatingDay";
import { validateGradesTick, reconcileFalseGradesV675 } from "./reconcileFalseGrades";
import { recomputePropsV676 } from "./recomputeProps";
import { backfillChalkCapV681 } from "./backfillChalkCap";
import { recordPassesV677 } from "./recordPassesV677";
import { backfillVirtualParlaysV680 } from "./virtualParlayBuilder";
import { runVirtualParlayTrack } from "./virtualParlayTracker";

function log(message: string, source = "live-props"): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [${source}] ${message}`);
}

export const LIVE_PROP_INTERVAL_MS = 60_000; // 60 seconds

// Injectable deps so a tick is testable without live HTTP. Production passes
// nothing and the real adapters are used.
export interface LiveTrackerDeps {
  activePicks: (date: string, sport?: string | null) => PropPickRow[];
  schedule: typeof fetchSchedule;
  fetchLiveFeed: typeof DEFAULT_LIVE_DEPS.fetchLiveFeed;
  resolvePlayerId: typeof resolveMlbPlayerId;
  writeState: typeof updatePropPickLiveState;
  settle: typeof settlePropPickWithBankroll;
}

const DEFAULT_DEPS: LiveTrackerDeps = {
  activePicks: activePropPicksForDate,
  schedule: fetchSchedule,
  fetchLiveFeed: DEFAULT_LIVE_DEPS.fetchLiveFeed,
  resolvePlayerId: resolveMlbPlayerId,
  writeState: updatePropPickLiveState,
  settle: settlePropPickWithBankroll,
};

export interface LiveTickSummary {
  date: string;
  tracked: number;
  transitions: number; // live_state writes that changed the stored value
  graded: number; // picks freshly settled this tick
}

function toTracked(p: PropPickRow): TrackedProp {
  // Resolve the game by the authoritative offer-side event_home/event_away.
  // prop_picks.team/opponent are unreliable — team is usually null and opponent
  // can carry a stale constant — and matching on that junk made the tracker
  // resolve the WRONG game (e.g. an unrelated final game), producing the v6.7.3
  // false grades. Prefer the offer teams; fall back to the pick's fields only
  // when the offer lookup is empty.
  const offer = getEventTeamsForGame(p.game_id);
  return {
    pick_id: p.pick_id,
    game_id: p.game_id,
    player_name: p.player_name,
    market_type: p.market_type,
    line: p.line,
    side: p.side,
    team: offer.home ?? p.team,
    opponent: offer.away ?? p.opponent,
    player_id: p.player_id != null ? Number(p.player_id) || null : null,
  };
}

// One tracking pass for a date. Computes the live state of each active pick,
// writes any changes, and grades picks whose game is final. Returns a summary.
export async function runLiveTrackTick(
  date: string = getOperatingDay(),
  deps: LiveTrackerDeps = DEFAULT_DEPS,
): Promise<LiveTickSummary> {
  // Defensive grade-validity sweep BEFORE processing: heal any prop pick that is
  // marked graded while its game is positively not final (the v6.7.3 failure
  // mode). Best-effort and idempotent; a healed pick reverts to ungraded and is
  // picked up as active below.
  await validateGradesTick(date).catch(() => 0);

  const picks = deps.activePicks(date, "mlb");
  if (picks.length === 0) return { date, tracked: 0, transitions: 0, graded: 0 };

  const schedule = await deps.schedule(date).catch(() => []);
  const tracking = await computeLiveTracking(picks.map(toTracked), {
    fetchLiveFeed: deps.fetchLiveFeed,
    resolvePlayerId: deps.resolvePlayerId,
    schedule,
  }).catch(() => ({} as Record<string, LiveTracking>));

  let transitions = 0;
  let graded = 0;

  for (const p of picks) {
    const t = tracking[p.pick_id];
    if (!t) continue;

    // Persist the live disposition (only count a transition when it changed).
    if (p.live_state !== t.liveState || p.live_value !== t.currentValue || p.live_status !== t.gameStatus) {
      try {
        deps.writeState(p.pick_id, t.liveState, t.currentValue, t.gameStatus);
        transitions++;
      } catch {
        // best-effort; a failed write just retries next tick
      }
    }

    // On a final game with a known value, grade once (settle + bankroll).
    if (t.gameStatus === "final" && t.currentValue != null) {
      const result = gradePropResult(p.side, p.line, t.currentValue);
      const units = p.stake_units ?? 0;
      const pl = plUnits(result, units, p.posted_odds);
      try {
        if (deps.settle(p.pick_id, result, t.currentValue, pl)) graded++;
      } catch {
        // best-effort; a failed settle retries next tick (settle is idempotent)
      }
    }
  }

  if (transitions > 0 || graded > 0) {
    log(`live tick ${date}: ${picks.length} tracked, ${transitions} state writes, ${graded} graded`);
  }

  // v6.7.9: advance the virtual parlays on the same tick now that this tick's
  // leg grades/live-states are written. Best-effort; never touches the bankroll.
  try {
    runVirtualParlayTrack();
  } catch {
    // best-effort; the next tick retries
  }

  return { date, tracked: picks.length, transitions, graded };
}

let timer: NodeJS.Timeout | null = null;

export function startLivePropTracker(): void {
  // One-shot boot maintenance, then the regular tracking loop. Both jobs are
  // idempotent (system_state flags), so a redeploy is safe:
  //   • reconcileFalseGradesV675 — heal v6.7.3 false grades
  //   • recomputePropsV676 — re-tier today's undecided picks against the fixed
  //     simulator (stale-edge cleanup) before the first live tick runs.
  //   • recordPassesV677 — backfill today's passed-on props (tier='PASS') that the
  //     pre-v6.7.7 pipeline dropped before any DB write. Additive, never re-grades.
  void reconcileFalseGradesV675()
    .catch(() => undefined)
    .then(() => recomputePropsV676().catch(() => undefined))
    .then(() => {
      // v6.8.1: re-tier undecided SNIPER picks (any date, both surfaces) that are
      // chalkier than the cap. The per-day recompute above only touches today, so
      // this catches stale chalk SNIPERs from prior slates the board still shows.
      // One-shot + flag-guarded; demoted PASS rows are stake-zeroed by the heal below.
      try {
        const b = backfillChalkCapV681();
        if (!b.alreadyCompleted && (b.demotedToEdge || b.demotedToPass)) {
          log(`chalk-cap backfill: ${b.demotedToEdge} → EDGE/RECON, ${b.demotedToPass} → PASS (chalk_cap)`);
        }
      } catch {
        // best-effort; idempotent, retries on next boot
      }
    })
    .then(() => recordPassesV677().catch(() => undefined))
    .then(() => {
      // HARD SAFETY: after any demotion/backfill, zero the stake on every PASS
      // row so an informational pick can never settle or touch bankroll. Cheap +
      // idempotent, so it runs unconditionally on every boot (not flag-guarded).
      try {
        const healed = healPassStakes();
        if (healed.props || healed.games || healed.reversed) {
          log(`healed PASS stakes: ${healed.props} props, ${healed.games} game-lines zeroed, ${healed.reversed} bad gradings reversed`);
        }
      } catch {
        // best-effort; never block the tracker on the heal
      }
      // v6.8.0: one-shot backfill of virtual singles over the last 7 days. Flag-
      // guarded + idempotent; wipes the old per-game groupings then rebuilds as
      // singles. Best-effort so it never blocks the first tick.
      try {
        backfillVirtualParlaysV680();
      } catch {
        // best-effort; the build is idempotent and the cycle hook keeps it fresh
      }
    })
    .finally(() => void runLiveTrackTick().catch(() => undefined));
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void runLiveTrackTick().catch(() => undefined);
  }, LIVE_PROP_INTERVAL_MS);
}

export function stopLivePropTracker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
