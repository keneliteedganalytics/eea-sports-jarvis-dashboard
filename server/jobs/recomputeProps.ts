// One-time prop recompute (v6.7.6). After the simulator baseline fix, every
// undecided prop pick on the current slate carries a stale edge/model_prob/tier
// computed by the OLD (miscalibrated) simulator — on the live board that meant 54
// SNIPER picks at a 29pp median edge. This job re-runs the (fixed) build pipeline
// for today's slate and reconciles the existing undecided picks against the fresh
// result set:
//   • a pick that still qualifies gets its edge/model_prob/tier/sim updated in place
//   • a pick that no longer clears the (tightened) thresholds is stamped tier='PASS'
//     so the default board filters it out while it stays queryable (?tier=ALL).
//
// Idempotent: guarded by a system_state flag so a redeploy can't re-run it. Only
// ungraded picks are touched (updatePropPickEval/markPropPickPass both no-op on a
// settled pick), so a graded result is never disturbed.

import {
  activePropPicksForDate,
  getPropPick,
  updatePropPickEval,
  markPropPickPass,
  getSystemState,
  setSystemState,
  type PropPickRow,
} from "../gradedBook";
import { buildMlbPropPicks, type BuildDeps } from "../sports/props/buildPropPicks";
import { getOperatingDay } from "../sports/mlb/operatingDay";

export const RECOMPUTE_FLAG = "recompute_v676_completed";
export const RECOMPUTE_AT = "recompute_v676_completed_at";

function log(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [recompute-v676] ${message}`);
}

export interface RecomputeSummary {
  scanned: number;
  updated: number; // re-tiered in place (still a pick)
  passed: number; // demoted to PASS (no longer clears thresholds)
  alreadyCompleted: boolean;
}

export interface RecomputeDeps {
  build: typeof buildMlbPropPicks;
  buildDeps?: BuildDeps;
  // gradedBook accessors are injectable so the job is testable without a live DB.
  activePicks: (date: string, sport?: string | null) => PropPickRow[];
  getPick: typeof getPropPick;
  markPass: typeof markPropPickPass;
  getState: typeof getSystemState;
  setState: typeof setSystemState;
}

const DEFAULT_DEPS: RecomputeDeps = {
  build: buildMlbPropPicks,
  activePicks: activePropPicksForDate,
  getPick: getPropPick,
  markPass: markPropPickPass,
  getState: getSystemState,
  setState: setSystemState,
};

export async function recomputePropsV676(
  date: string = getOperatingDay(),
  deps: RecomputeDeps = DEFAULT_DEPS,
): Promise<RecomputeSummary> {
  if (deps.getState(RECOMPUTE_FLAG) === "true") {
    return { scanned: 0, updated: 0, passed: 0, alreadyCompleted: true };
  }

  // Snapshot the existing undecided picks BEFORE the rebuild so we can detect
  // which ones the fresh (fixed) pipeline no longer surfaces.
  const before = deps.activePicks(date, "mlb");

  // Re-run the build with the corrected simulator. This re-simulates every offer,
  // applies the tightened gates, and upserts the fresh survivors in place (keyed
  // by pick_id), so any pick that survives is rewritten with new edge/tier/sim.
  const summary = await deps
    .build(date, deps.buildDeps)
    .catch((err) => {
      log(`rebuild errored: ${(err as Error).message}`);
      return { date, considered: 0, written: 0, pickIds: [] as string[] };
    });
  const survivors = new Set(summary.pickIds);

  let updated = 0;
  let passed = 0;
  for (const p of before) {
    if (survivors.has(p.pick_id)) {
      // The rebuild already upserted the fresh evaluation in place.
      const row = deps.getPick(p.pick_id);
      if (row && row.tier !== "PASS") updated++;
      continue;
    }
    // No longer surfaced by the fixed pipeline → demote to PASS (keeps it queryable).
    deps.markPass(p.pick_id);
    passed++;
  }

  deps.setState(RECOMPUTE_FLAG, "true");
  deps.setState(RECOMPUTE_AT, new Date().toISOString());
  log(`scanned ${before.length} undecided pick(s): ${updated} re-tiered, ${passed} demoted to PASS`);
  return { scanned: before.length, updated, passed, alreadyCompleted: false };
}

export function recomputeFlag(): { ran: boolean; completedAt: string | null } {
  return {
    ran: getSystemState(RECOMPUTE_FLAG) === "true",
    completedAt: getSystemState(RECOMPUTE_AT),
  };
}

// `updatePropPickEval` is imported so a future targeted single-pick recompute can
// reuse it without the full rebuild; referenced here to keep the dep explicit.
export { updatePropPickEval };
