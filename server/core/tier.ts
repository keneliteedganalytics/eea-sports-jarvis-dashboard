// Verdict tier assignment — ported from sports-engine sports/mlb/picks_engine.py.
// Locked May 13, 2026. picks_engine.assign_tier is the single source of truth.

import type { Verdict } from "./types";

// Tier thresholds (locked)
export const EDGE_THRESHOLD_PP = 2.0;
export const TIER_RECON_EDGE = 2.0;
export const TIER_RECON_CONF = 55;
export const TIER_EDGE_EDGE = 6.0;
export const TIER_EDGE_CONF = 70;
export const TIER_SNIPER_EDGE = 8.0;
export const TIER_SNIPER_CONF = 80;
export const TIER_SNIPER_POLY = 55;
export const TIER_BONUS_POLY = 60;
export const MIN_CONFIDENCE = 42;

const TIER_LADDER: Verdict[] = ["BONUS", "SNIPER", "EDGE", "RECON", "VALUE", "LEAN", "PASS"];

function downgradeTier(tier: Verdict): Verdict {
  const idx = TIER_LADDER.indexOf(tier);
  if (idx < 0) return tier;
  return TIER_LADDER[Math.min(idx + 1, TIER_LADDER.length - 1)];
}

export interface TierInput {
  edgePp: number | null;
  confidence: number | null;
  polyPct?: number | null;
  evPer100?: number | null;
  hardPass?: boolean;
  trapCapped?: boolean;
  oddsAmerican?: number | null;
  winProb?: number | null;
}

export function assignTier(input: TierInput): Verdict {
  const { edgePp, confidence, polyPct, hardPass, trapCapped, oddsAmerican, winProb } = input;

  if (hardPass) return "PASS";
  if (edgePp === null || edgePp === undefined) return "PASS";

  const edge = Number(edgePp);
  const conf = Number(confidence ?? 0);

  const baseTier = computeBaseTier(edge, conf, polyPct, oddsAmerican, winProb);

  if (
    trapCapped &&
    (baseTier === "BONUS" ||
      baseTier === "SNIPER" ||
      baseTier === "EDGE" ||
      baseTier === "RECON" ||
      baseTier === "VALUE")
  ) {
    return downgradeTier(baseTier);
  }
  return baseTier;
}

function computeBaseTier(
  edge: number,
  conf: number,
  polyPct: number | null | undefined,
  oddsAmerican: number | null | undefined,
  winProb: number | null | undefined,
): Verdict {
  // BONUS: triple-confirmed
  if (
    edge >= TIER_SNIPER_EDGE &&
    conf >= TIER_SNIPER_CONF &&
    polyPct !== null &&
    polyPct !== undefined &&
    polyPct >= TIER_BONUS_POLY
  ) {
    return "BONUS";
  }

  // SNIPER
  if (edge >= TIER_SNIPER_EDGE && conf >= TIER_SNIPER_CONF) return "SNIPER";

  // EDGE — three paths
  if (edge >= TIER_EDGE_EDGE && conf >= TIER_EDGE_CONF) return "EDGE";
  if (edge >= TIER_SNIPER_EDGE && conf >= TIER_RECON_CONF) return "EDGE";
  if (edge >= 5.0 && conf >= TIER_EDGE_CONF) return "EDGE";

  // VALUE — betting the price, not the team
  const isPlusMoney = oddsAmerican !== null && oddsAmerican !== undefined && oddsAmerican > 0;
  const isUnderdog = winProb !== null && winProb !== undefined && winProb < 0.5;
  if (isPlusMoney && isUnderdog && edge >= 4.0 && conf >= TIER_RECON_CONF) {
    return "VALUE";
  }

  // RECON
  if (edge >= TIER_RECON_EDGE && conf >= TIER_RECON_CONF) return "RECON";

  // LEAN
  if (edge >= 2.0) return "LEAN";

  return "PASS";
}

// ── Display helpers (locked hex per SPEC §3) ─────────────────────

export const PILL_LABEL: Record<Verdict, string> = {
  BONUS: "★ BONUS PLAY",
  SNIPER: "SNIPER PLAY",
  EDGE: "EDGE PLAY",
  RECON: "RECON PLAY",
  VALUE: "VALUE PLAY",
  LEAN: "LEAN",
  PASS: "PASS",
};

export function isActionable(verdict: Verdict): boolean {
  return ["BONUS", "SNIPER", "EDGE", "RECON", "VALUE"].includes(verdict);
}
