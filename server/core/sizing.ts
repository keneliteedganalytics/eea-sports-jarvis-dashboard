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

// Conviction-based unit count per verdict tier (v5 collapsed ladder):
// SNIPER 2.5, EDGE 2.0, RECON 1.0, PASS 0.
export function convictionUnits(tier: Verdict): number {
  switch (tier) {
    case "SNIPER":
      return 2.5;
    case "EDGE":
      return 2.0;
    case "RECON":
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

export interface ExposureStake {
  units: number;
  stakeDollars: number;
  trimmed: boolean;
}

// 18% slate-wide exposure cap (SPEC §4). If total staked dollars across the
// whole board exceed 18% of bankroll, scale every actionable stake down by a
// single common factor and flag the trimmed plays. Stakes are returned in the
// same order they were passed in.
export function applyExposureCap(
  stakes: { units: number; stakeDollars: number }[],
  bankroll: number,
): ExposureStake[] {
  const cap = bankroll * EXPOSURE_CAP_PCT;
  const total = stakes.reduce((s, x) => s + x.stakeDollars, 0);
  if (total <= cap || total === 0) {
    return stakes.map((x) => ({ ...x, trimmed: false }));
  }
  const factor = cap / total;
  return stakes.map((x) => {
    if (x.stakeDollars <= 0) return { ...x, trimmed: false };
    return {
      units: Math.round(x.units * factor * 100) / 100,
      stakeDollars: Math.round(x.stakeDollars * factor),
      trimmed: true,
    };
  });
}
