// EEA flat-unit sizing (SPEC §4, EEA operating rules). Replaces Quarter-Kelly.
// A unit is a flat 1.5% of bankroll, recomputed daily off the prior close. Each
// conviction tier maps to an exact unit count (the engine finalizes — no range).
// Any line worse than -180 is half-staked. A slate-wide 18% exposure cap is
// enforced downstream in the orchestrator.

import type { Verdict } from "./types";

export const FLAT_UNIT_PCT = 0.015; // 1.5% of bankroll per unit
export const JUICE_HALF_CUT_THRESHOLD = -180; // line worse than -180 → half stake
export const EXPOSURE_CAP_PCT = 0.18; // 18% slate exposure cap

// Dollar value of one unit (1.5% of bankroll, rounded to the cent).
export function computeUnit(bankroll: number): number {
  return Math.round(bankroll * FLAT_UNIT_PCT * 100) / 100;
}

// Conviction-based unit count per verdict tier. Engine FINALIZES the exact
// number (Ken's locked answer 2026-06-07): BONUS 3, SNIPER 2.5, EDGE 2,
// RECON 1.5, VALUE/LEAN 1, PASS 0.
export function convictionUnits(tier: Verdict): number {
  switch (tier) {
    case "BONUS":
      return 3.0;
    case "SNIPER":
      return 2.5;
    case "EDGE":
      return 2.0;
    case "RECON":
      return 1.5;
    case "VALUE":
      return 1.0;
    case "LEAN":
      return 1.0;
    case "PASS":
      return 0;
    default:
      return 0;
  }
}

export interface JuiceResult {
  units: number;
  halfCut: boolean;
}

// Half-stake any line beyond -180 (EEA juice penalty, applied after sizing).
export function applyJuicePenalty(units: number, americanOdds: number | null): JuiceResult {
  if (americanOdds !== null && americanOdds < JUICE_HALF_CUT_THRESHOLD) {
    return { units: units / 2, halfCut: true };
  }
  return { units, halfCut: false };
}

// Convert a unit count to a whole-dollar stake at the current unit size.
export function unitsToStake(units: number, bankroll: number): number {
  return Math.round(units * computeUnit(bankroll));
}
