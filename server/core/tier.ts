// Verdict tier assignment (v5 collapsed ladder). Exactly four tiers:
// SNIPER, EDGE, RECON, PASS. assignTier is the single source of truth.

import type { Verdict } from "./types";

// Tier thresholds (v5 locked):
//   SNIPER  edge ≥ 7pp AND confidence ≥ 65 → 2.5u
//   EDGE    edge ≥ 5pp AND confidence ≥ 55 → 2.0u
//   RECON   edge ≥ 3pp AND confidence ≥ 50 → 1.0u
//   PASS    otherwise (not displayed in plays-only)
export const TIER_SNIPER_EDGE = 7.0;
export const TIER_SNIPER_CONF = 65;
export const TIER_EDGE_EDGE = 5.0;
export const TIER_EDGE_CONF = 55;
export const TIER_RECON_EDGE = 3.0;
export const TIER_RECON_CONF = 50;
export const MIN_CONFIDENCE = TIER_RECON_CONF;
export const EDGE_THRESHOLD_PP = TIER_RECON_EDGE;

const TIER_LADDER: Verdict[] = ["SNIPER", "EDGE", "RECON", "PASS"];

// Step a tier down one rung (used by trap caps + lineup star-out downgrades).
export function downgradeTier(tier: Verdict): Verdict {
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
  const { edgePp, confidence, hardPass, trapCapped } = input;

  if (hardPass) return "PASS";
  if (edgePp === null || edgePp === undefined) return "PASS";

  const edge = Number(edgePp);
  const conf = Number(confidence ?? 0);

  const baseTier = computeBaseTier(edge, conf);

  if (trapCapped && baseTier !== "PASS") {
    return downgradeTier(baseTier);
  }
  return baseTier;
}

function computeBaseTier(edge: number, conf: number): Verdict {
  if (edge >= TIER_SNIPER_EDGE && conf >= TIER_SNIPER_CONF) return "SNIPER";
  if (edge >= TIER_EDGE_EDGE && conf >= TIER_EDGE_CONF) return "EDGE";
  if (edge >= TIER_RECON_EDGE && conf >= TIER_RECON_CONF) return "RECON";
  return "PASS";
}

// ── Display helpers (v5 gold ramp) ───────────────────────────────

export const PILL_LABEL: Record<Verdict, string> = {
  SNIPER: "SNIPER PLAY",
  EDGE: "EDGE PLAY",
  RECON: "RECON PLAY",
  PASS: "PASS",
};

// Tier colors (v5 locked).
export const TIER_COLOR: Record<Verdict, string> = {
  SNIPER: "#E8C14A",
  EDGE: "#C9A227",
  RECON: "#9A7B1E",
  PASS: "#6B7A99",
};

export function isActionable(verdict: Verdict): boolean {
  return verdict === "SNIPER" || verdict === "EDGE" || verdict === "RECON";
}
