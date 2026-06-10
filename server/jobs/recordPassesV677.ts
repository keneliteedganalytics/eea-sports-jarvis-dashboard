// One-time PASS backfill (v6.7.7). The prop build now records every evaluated
// pick — actionable AND passed-on (tier='PASS' with a pass_reason). But today's
// slate was already built by the pre-v6.7.7 pipeline, which dropped passed props
// before any DB write (they left only a pick_audit string). This job re-runs the
// build for today so those PASS props are persisted with full metadata.
//
// Purely additive: buildMlbPropPicks upserts by pick_id and never overwrites a
// graded row, so existing actionable picks and any settled results are untouched —
// it only fills in the missing PASS rows (and refreshes ungraded actionable ones).
//
// Idempotent: guarded by a system_state flag so a redeploy can't re-run it.

import {
  getSystemState,
  setSystemState,
} from "../gradedBook";
import { buildMlbPropPicks, type BuildDeps, type BuildSummary } from "../sports/props/buildPropPicks";
import { getOperatingDay } from "../sports/mlb/operatingDay";

export const RECORD_PASSES_FLAG = "record_passes_v677_completed";
export const RECORD_PASSES_AT = "record_passes_v677_completed_at";

function log(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [record-passes-v677] ${message}`);
}

export interface RecordPassesSummary {
  written: number; // actionable picks the rebuild surfaced
  passed: number; // PASS rows recorded
  alreadyCompleted: boolean;
}

export interface RecordPassesDeps {
  build: typeof buildMlbPropPicks;
  buildDeps?: BuildDeps;
  getState: typeof getSystemState;
  setState: typeof setSystemState;
}

const DEFAULT_DEPS: RecordPassesDeps = {
  build: buildMlbPropPicks,
  getState: getSystemState,
  setState: setSystemState,
};

export async function recordPassesV677(
  date: string = getOperatingDay(),
  deps: RecordPassesDeps = DEFAULT_DEPS,
): Promise<RecordPassesSummary> {
  if (deps.getState(RECORD_PASSES_FLAG) === "true") {
    return { written: 0, passed: 0, alreadyCompleted: true };
  }

  const summary: BuildSummary = await deps
    .build(date, deps.buildDeps)
    .catch((err) => {
      log(`rebuild errored: ${(err as Error).message}`);
      return { date, considered: 0, written: 0, passed: 0, pickIds: [] as string[] };
    });

  deps.setState(RECORD_PASSES_FLAG, "true");
  deps.setState(RECORD_PASSES_AT, new Date().toISOString());
  log(`backfilled ${date}: ${summary.written} actionable, ${summary.passed} PASS recorded`);
  return { written: summary.written, passed: summary.passed, alreadyCompleted: false };
}

export function recordPassesFlag(): { ran: boolean; completedAt: string | null } {
  return {
    ran: getSystemState(RECORD_PASSES_FLAG) === "true",
    completedAt: getSystemState(RECORD_PASSES_AT),
  };
}
