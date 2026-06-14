// One-shot SNIPER chalk-cap backfill (v6.8.1). The chalk cap (added to
// assignTier / assignPropTier) only gates a pick at evaluation time. New picks
// are gated as they're built, and today's undecided picks are re-tiered by the
// per-day recompute — but undecided SNIPER picks posted on PRIOR slates are
// never re-evaluated (the build only touches the operating day), so a pre-cap
// chalk SNIPER would keep its SNIPER tier until it grades. The board surfaces
// undecided picks across all dates, so those stale chalk SNIPERs stay visible.
//
// This job re-runs the (now chalk-aware) classifiers against every undecided
// SNIPER pick on BOTH surfaces and rewrites the tier in place:
//   • a chalk pick that still clears EDGE → EDGE (or RECON)
//   • one that clears nothing → PASS with pass_reason 'chalk_cap'
// Non-chalk SNIPERs re-classify to SNIPER and are left untouched. Idempotent:
// guarded by a system_state flag, and naturally a no-op on a second pass (no
// chalk SNIPERs remain). Only undecided rows are touched; locked game picks and
// graded rows of either surface are skipped by the gradedBook accessors.

import {
  undecidedSniperProps,
  undecidedSniperGamePicks,
  setPropPickTier,
  markPropPickPass,
  setGamePickTier,
  getSystemState,
  setSystemState,
} from "../gradedBook";
import { assignTier, isChalkierThanSniperCap, chalkCapReason } from "../core/tier";
import { assignPropTier } from "../sports/props/buildPropPicks";
import type { HitRates } from "../sports/props/hitRates";

export const BACKFILL_FLAG = "chalk_cap_backfill_v681_completed";
export const BACKFILL_AT = "chalk_cap_backfill_v681_completed_at";

function log(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [backfill-chalk-v681] ${message}`);
}

export interface ChalkCapBackfillSummary {
  scannedProps: number;
  scannedGames: number;
  demotedToEdge: number; // props + games that re-tiered to EDGE/RECON
  demotedToPass: number; // props + games stamped PASS (chalk_cap)
  alreadyCompleted: boolean;
}

export interface BackfillDeps {
  sniperProps: typeof undecidedSniperProps;
  sniperGames: typeof undecidedSniperGamePicks;
  setPropTier: typeof setPropPickTier;
  passProp: typeof markPropPickPass;
  setGameTier: typeof setGamePickTier;
  getState: typeof getSystemState;
  setState: typeof setSystemState;
}

const DEFAULT_DEPS: BackfillDeps = {
  sniperProps: undecidedSniperProps,
  sniperGames: undecidedSniperGamePicks,
  setPropTier: setPropPickTier,
  passProp: markPropPickPass,
  setGameTier: setGamePickTier,
  getState: getSystemState,
  setState: setSystemState,
};

// Parse the stored hit-rate windows; tolerate a missing/garbled blob by handing
// the classifier empty windows (which won't be "aligned", so the pick can't
// re-qualify as SNIPER or EDGE on hit-rate — exactly the conservative outcome).
function parseWindows(json: string | null): { l10: HitRates["l10"]; l20: HitRates["l20"] } {
  const empty = { decided: 0, over: 0, rate: null };
  if (!json) return { l10: empty, l20: empty };
  try {
    const hr = JSON.parse(json) as Partial<HitRates>;
    return { l10: hr.l10 ?? empty, l20: hr.l20 ?? empty };
  } catch {
    return { l10: empty, l20: empty };
  }
}

export function backfillChalkCapV681(deps: BackfillDeps = DEFAULT_DEPS): ChalkCapBackfillSummary {
  if (deps.getState(BACKFILL_FLAG) === "true") {
    return { scannedProps: 0, scannedGames: 0, demotedToEdge: 0, demotedToPass: 0, alreadyCompleted: true };
  }

  let demotedToEdge = 0;
  let demotedToPass = 0;

  // ── Props ──────────────────────────────────────────────────────────────────
  const props = deps.sniperProps();
  for (const p of props) {
    const price = p.posted_odds ?? p.best_price ?? null;
    if (!isChalkierThanSniperCap(price)) continue; // non-chalk SNIPER stays
    const { l10, l20 } = parseWindows(p.hit_rates_json);
    const tier = assignPropTier({
      edgePp: p.edge_pp ?? 0,
      side: p.side,
      l10,
      l20,
      dataQualityTier: p.data_quality_tier ?? "HIGH",
      american: price,
    });
    if (tier === "PASS") {
      deps.passProp(p.pick_id, "chalk_cap");
      demotedToPass++;
    } else {
      deps.setPropTier(p.pick_id, tier); // EDGE or RECON
      demotedToEdge++;
    }
  }

  // ── Game lines ───────────────────────────────────────────────────────────────
  const games = deps.sniperGames();
  for (const g of games) {
    const price = g.pickMl ?? null;
    if (!isChalkierThanSniperCap(price)) continue;
    const tier = assignTier({
      edgePp: g.edgePp,
      confidence: g.confidence,
      winProb: g.pickWinProb,
      evPer100: g.evPer100,
      oddsAmerican: price,
      // game picks don't persist a data-quality tier; assignTier defaults to HIGH.
    });
    if (tier === "PASS") {
      deps.setGameTier(g.id, "PASS", chalkCapReason(price));
      demotedToPass++;
    } else {
      deps.setGameTier(g.id, tier);
      demotedToEdge++;
    }
  }

  deps.setState(BACKFILL_FLAG, "true");
  deps.setState(BACKFILL_AT, new Date().toISOString());
  log(`scanned ${props.length} prop + ${games.length} game SNIPER(s): ${demotedToEdge} → EDGE/RECON, ${demotedToPass} → PASS(chalk_cap)`);
  return {
    scannedProps: props.length,
    scannedGames: games.length,
    demotedToEdge,
    demotedToPass,
    alreadyCompleted: false,
  };
}

export function chalkCapBackfillFlag(): { ran: boolean; completedAt: string | null } {
  return {
    ran: getSystemState(BACKFILL_FLAG) === "true",
    completedAt: getSystemState(BACKFILL_AT),
  };
}
