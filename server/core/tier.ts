// Verdict tier assignment (v6.6 sharp calibration). Exactly four tiers:
// SNIPER, EDGE, RECON, PASS. assignTier is the single source of truth.
//
// v6.6 tightens every tier with AND-gates on win-prob floor, data quality, and
// an EV sanity ceiling, plus a set of hard PASS gates that fire regardless of
// edge. The gates exist to kill the phantom long-shot dog edges that the old
// [0.15, 0.85] clamp + 0.45 market blend manufactured at the tails.

import type { Verdict } from "./types";

// ── Tier edge floors (v6.6: lowered slightly, but AND-gated below) ──
export const TIER_SNIPER_EDGE = 6.0;
export const TIER_SNIPER_CONF = 70;
export const TIER_EDGE_EDGE = 4.0;
export const TIER_EDGE_CONF = 60;
export const TIER_RECON_EDGE = 2.5;
export const TIER_RECON_CONF = 50;
export const MIN_CONFIDENCE = TIER_RECON_CONF;
export const EDGE_THRESHOLD_PP = TIER_RECON_EDGE;

// ── Win-probability floors per tier (v6.6) ──────────────────────────
export const TIER_SNIPER_WINPROB = 0.3;
export const TIER_EDGE_WINPROB = 0.25;
export const TIER_RECON_WINPROB = 0.2;

// ── EV-per-100 ceiling for SNIPER (v6.6) ────────────────────────────
export const TIER_SNIPER_EV_MAX = 25;

// ── SNIPER chalk cap (v6.8.1) ───────────────────────────────────────
// 7-day data: SNIPER hits 71.8% but posts −4.3% ROI because heavy chalk pays
// $12–$30 yet costs $100 when it busts. SNIPER is reserved for viable prices: a
// negative-American price chalkier (more negative) than this cap cannot be
// SNIPER — it demotes to EDGE if it still clears EDGE, else PASS. Boundary is
// EXCLUSIVE: −250 stays SNIPER; only −251 and chalkier demote. Env-overridable
// via SNIPER_MAX_CHALK_AMERICAN (must be negative) so we can dial without a
// redeploy. Single source of truth for both game-line and prop surfaces.
export const SNIPER_MAX_CHALK_AMERICAN = (() => {
  const env = Number(process.env.SNIPER_MAX_CHALK_AMERICAN);
  return Number.isFinite(env) && env < 0 ? env : -250;
})();

// True when a price is chalkier than the SNIPER cap (e.g. −300 < −250). A null
// price is never chalk (can't disqualify what we can't price).
export function isChalkierThanSniperCap(american: number | null | undefined): boolean {
  return american != null && american < SNIPER_MAX_CHALK_AMERICAN;
}

// A short audit string for a chalk-capped demotion, e.g. "chalk cap (-300 past
// -250)". Used as the game-line passReason so persistPicks can attribute it to
// the chalk_cap chip. The word "chalk" is the marker gamePassReason keys on.
export function chalkCapReason(american: number | null | undefined): string {
  return `chalk cap (${american} past ${SNIPER_MAX_CHALK_AMERICAN})`;
}

// ── Hard PASS gate thresholds (v6.6) ────────────────────────────────
export const HARD_PASS_TRAP_GAP_PP = 25; // trapSignal AND gap > 25 → PASS (was 30)
export const HARD_PASS_EV_PER_100 = 30; // EV/$100 above this is a calibration artifact
export const HARD_PASS_MAX_ODDS = 1000; // American odds longer than +1000 → PASS
export const HARD_PASS_MIN_WINPROB = 0.1; // win prob under 10% → not in the lotto business

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
  // v6.6 gating inputs (optional; default to the most permissive value so
  // callers that don't model these — e.g. the two-way market builder — keep
  // their prior behavior).
  trapSignal?: boolean;
  trapGapPp?: number | null;
  dataQualityTier?: string | null;
}

// Result of a hard-gate evaluation. fired=true means force PASS; reason is a
// short human string for the card / API (null when no gate fired).
export interface HardGateResult {
  fired: boolean;
  reason: string | null;
}

// Evaluate the v6.6 hard PASS gates. Returns the FIRST gate that fires (order is
// significant: most-specific / most-informative reason first). These run before
// the edge/confidence ladder and short-circuit it.
export function evaluateHardGates(input: TierInput): HardGateResult {
  const { trapSignal, trapGapPp, evPer100, oddsAmerican, winProb } = input;

  if (trapSignal === true && (trapGapPp ?? 0) > HARD_PASS_TRAP_GAP_PP) {
    return {
      fired: true,
      reason: `trap signal (${Math.round(trapGapPp ?? 0)}pp public/sharp gap)`,
    };
  }
  if (evPer100 !== null && evPer100 !== undefined && evPer100 > HARD_PASS_EV_PER_100) {
    return {
      fired: true,
      reason: `EV +${Math.round(evPer100)}/$100 exceeds sanity ceiling`,
    };
  }
  if (oddsAmerican !== null && oddsAmerican !== undefined && oddsAmerican > HARD_PASS_MAX_ODDS) {
    return {
      fired: true,
      reason: `+${oddsAmerican} exceeds max odds policy`,
    };
  }
  if (winProb !== null && winProb !== undefined && winProb < HARD_PASS_MIN_WINPROB) {
    return {
      fired: true,
      reason: `win prob ${(winProb * 100).toFixed(0)}% below 10% floor`,
    };
  }
  return { fired: false, reason: null };
}

export function assignTier(input: TierInput): Verdict {
  const { edgePp, confidence, hardPass, trapCapped } = input;

  if (hardPass) return "PASS";
  if (evaluateHardGates(input).fired) return "PASS";
  if (edgePp === null || edgePp === undefined) return "PASS";

  const edge = Number(edgePp);
  const conf = Number(confidence ?? 0);

  const baseTier = computeBaseTier(edge, conf, input);

  if (trapCapped && baseTier !== "PASS") {
    return downgradeTier(baseTier);
  }
  return baseTier;
}

function computeBaseTier(edge: number, conf: number, input: TierInput): Verdict {
  // Win prob defaults to 1 (permissive) so the two-way market builder — which
  // passes the side win prob explicitly — is gated, while bare callers are not
  // accidentally downgraded.
  const wp = input.winProb ?? 1;
  const ev = input.evPer100 ?? 0;
  const dq = (input.dataQualityTier ?? "HIGH").toUpperCase();
  const dqHigh = dq === "HIGH";
  const dqHighOrMed = dq === "HIGH" || dq === "MEDIUM";

  if (
    edge >= TIER_SNIPER_EDGE &&
    conf >= TIER_SNIPER_CONF &&
    ev <= TIER_SNIPER_EV_MAX &&
    wp >= TIER_SNIPER_WINPROB &&
    dqHigh &&
    // v6.8.1: heavy chalk can't be SNIPER. Fall through to the EDGE check so a
    // chalk pick that still clears EDGE becomes EDGE (else RECON/PASS).
    !isChalkierThanSniperCap(input.oddsAmerican)
  ) {
    return "SNIPER";
  }
  if (
    edge >= TIER_EDGE_EDGE &&
    conf >= TIER_EDGE_CONF &&
    wp >= TIER_EDGE_WINPROB &&
    dqHighOrMed
  ) {
    return "EDGE";
  }
  if (edge >= TIER_RECON_EDGE && conf >= TIER_RECON_CONF && wp >= TIER_RECON_WINPROB) {
    return "RECON";
  }
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
