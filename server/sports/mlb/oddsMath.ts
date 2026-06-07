// MLB odds math — single source of truth lives in core/odds.ts (conversions,
// additive + Shin de-vig, consensus). This module re-exports the Shin solver,
// synthetic-no-hold line, and consensus helpers under the SPEC §8 path so MLB
// callers import from sports/mlb/oddsMath.

export {
  americanToProb,
  probToAmerican,
  americanToDecimal,
  decimalToAmerican,
  devigAdditive,
  devigShin,
  syntheticNoHoldLine,
  consensusSnhl,
  bestPrice,
  medianPrice,
  TRUSTED_BOOKS,
} from "../../core/odds";
export type { SNHL, Bookmaker, Consensus } from "../../core/odds";
