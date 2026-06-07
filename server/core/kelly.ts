// Stake sizing — ported from sports-engine core/kelly.py + picks_engine Kelly math.
// Quarter-Kelly with a 3% bankroll hard cap.

import { americanToDecimal } from "./odds";

export const KELLY_FRACTION = 0.25; // quarter-Kelly
export const KELLY_CAP_PCT = 0.03; // 3% bankroll hard cap
export const MIN_STAKE_DOLLARS = 1.0;
export const MAX_DISPLAY_UNITS = 5;

// 1 unit = bankroll * 0.25 / 3
export function unitSize(bankroll: number): number {
  return (bankroll * 0.25) / 3.0;
}

export function expectedValue(
  modelProb: number | null,
  americanOdds: number | null,
  stake = 100.0,
): number {
  if (modelProb === null || americanOdds === null) return 0.0;
  const dec = americanToDecimal(americanOdds);
  if (dec === null) return 0.0;
  const profitIfWin = stake * (dec - 1.0);
  return modelProb * profitIfWin - (1.0 - modelProb) * stake;
}

// Full-Kelly fraction of bankroll. Returns 0 when no edge.
export function kellyFraction(modelProb: number | null, americanOdds: number | null): number {
  if (modelProb === null || americanOdds === null) return 0.0;
  const dec = americanToDecimal(americanOdds);
  if (dec === null) return 0.0;
  const b = dec - 1.0;
  const p = modelProb;
  const q = 1.0 - p;
  if (b <= 0) return 0.0;
  const f = (b * p - q) / b;
  return Math.max(0.0, f);
}

export interface KellyResult {
  fullKelly: number;
  kellyUsed: number;
  finalFraction: number;
  stakeDollars: number;
  capped: boolean;
}

// Quarter-Kelly stake with 3% cap. Mirrors picks_engine.compute_kelly_stake.
export function computeKellyStake(
  modelProb: number | null,
  americanOdds: number | null,
  bankroll: number,
  kellyFrac = KELLY_FRACTION,
  capPct = KELLY_CAP_PCT,
): KellyResult {
  const zero: KellyResult = {
    fullKelly: 0,
    kellyUsed: 0,
    finalFraction: 0,
    stakeDollars: 0,
    capped: false,
  };
  if (modelProb === null || americanOdds === null) return zero;
  const dec = americanToDecimal(americanOdds);
  if (dec === null || dec <= 1.0) return zero;

  const b = dec - 1.0;
  const p = modelProb;
  const q = 1.0 - p;
  const fullKelly = (b * p - q) / b;
  if (fullKelly <= 0) return zero;

  const kellyUsed = fullKelly * kellyFrac;
  const capped = kellyUsed > capPct;
  const finalFraction = Math.min(kellyUsed, capPct);
  const stakeDollars = round2(bankroll * finalFraction);

  return {
    fullKelly: round(fullKelly, 4),
    kellyUsed: round(kellyUsed, 4),
    finalFraction: round(finalFraction, 4),
    stakeDollars,
    capped,
  };
}

// Convert dollar stake → conviction units (rounded to 0.5u, capped display).
export function unitsFromStake(stakeDollars: number, unit: number): number {
  if (!unit || unit <= 0) return 0.0;
  const rawU = stakeDollars / unit;
  return Math.min(Math.round(rawU * 2) / 2.0, MAX_DISPLAY_UNITS);
}

function round(x: number, places: number): number {
  const f = Math.pow(10, places);
  return Math.round(x * f) / f;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
