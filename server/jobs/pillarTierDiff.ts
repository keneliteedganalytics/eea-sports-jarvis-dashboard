// v6.9.0 — one-time boot tier-diff log (SHADOW). Reports how many undecided
// SNIPER picks WOULD move tier if the stricter multi-signal SNIPER gate were
// enforced, WITHOUT mutating anything. Until the parallel surface wires the
// SHARP/PREDICT feeds, the gate degrades to the model-only ≥6pp rule, so this
// answers "how much would change if we flipped the gate on today" — a safe,
// read-only sanity check the spec asks for. No bankroll, no DB writes.

import { gradedDb } from "../gradedBook";
import {
  signalAgreementForSniper,
  type PickSignals,
} from "../../shared/types/signals";

export interface PillarTierDiff {
  scannedProps: number;
  scannedGames: number;
  wouldDemoteProps: number;
  wouldDemoteGames: number;
}

// Build a model-only PickSignals from a pick's stored edge. We don't have SHARP/
// PREDICT in the DB yet, so the gate uses the degraded model-only rule. Side is
// irrelevant to the model-only path; we pass a placeholder.
function modelOnlySignals(edgePp: number | null): PickSignals {
  return {
    market: null,
    sharp: null,
    model: { prob: null, edgePp, side: "home" },
    prism: null,
    predict: null,
  };
}

// Read-only scan. Logs a single summary line; returns the diff for tests/debug.
export function logPillarTierDiff(): PillarTierDiff {
  const empty: PillarTierDiff = {
    scannedProps: 0, scannedGames: 0, wouldDemoteProps: 0, wouldDemoteGames: 0,
  };
  try {
    const db = gradedDb();
    const props = db
      .prepare("SELECT edge_pp FROM prop_picks WHERE result IS NULL AND tier = 'SNIPER'")
      .all() as Array<{ edge_pp: number | null }>;
    const games = db
      .prepare("SELECT edgePp FROM picks WHERE status != 'final' AND locked = 0 AND tier = 'SNIPER'")
      .all() as Array<{ edgePp: number | null }>;

    let wp = 0;
    for (const p of props) {
      if (!signalAgreementForSniper(modelOnlySignals(p.edge_pp)).ok) wp++;
    }
    let wg = 0;
    for (const g of games) {
      if (!signalAgreementForSniper(modelOnlySignals(g.edgePp)).ok) wg++;
    }

    const diff: PillarTierDiff = {
      scannedProps: props.length,
      scannedGames: games.length,
      wouldDemoteProps: wp,
      wouldDemoteGames: wg,
    };
    console.log(
      `[v6.9.0 pillars] SHADOW tier-diff: ${diff.scannedProps} SNIPER props / ${diff.scannedGames} SNIPER games scanned; ` +
      `would demote ${diff.wouldDemoteProps} props + ${diff.wouldDemoteGames} games under the strict signal gate (no change applied)`,
    );
    return diff;
  } catch {
    return empty;
  }
}
