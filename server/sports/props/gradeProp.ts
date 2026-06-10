// Player-prop grading. A prop settles by comparing the player's actual stat to
// the posted line for the picked side:
//   over  → actual > line wins, actual < line loses, actual == line pushes
//   under → actual < line wins, actual > line loses, actual == line pushes
// The P/L math is the same American-odds payout the game-line book uses.
//
// This is the storage + grading entry point for the prop pipeline. Prop GENERATION
// is a follow-up — for now props are graded once an actual value is supplied.

import { plUnits, type Result } from "../../grading";
import { getPropPick, settlePropPick, type PropSide } from "../../gradedBook";

// Pure over/under rule at the line. Exposed for direct unit testing.
export function gradePropResult(side: PropSide, line: number, actualValue: number): Result {
  if (actualValue === line) return "P";
  const isOver = actualValue > line;
  return (side === "over") === isOver ? "W" : "L";
}

export interface GradePropOutcome {
  pickId: string;
  result: Result;
  actualValue: number;
  plUnits: number;
  plDollars: number;
}

// Grade a stored prop pick against the player's actual stat value, write the
// result + actual + P/L, and return the outcome. Returns null when the pick id
// isn't in the book. A 1-unit-equivalent stake is assumed for the dollar P/L
// scaling when no explicit stake is stored on the prop (props carry odds, not a
// dollar stake yet — that arrives with prop generation).
export function gradePropPick(pickId: string, actualValue: number): GradePropOutcome | null {
  const row = getPropPick(pickId);
  if (!row) return null;
  const result = gradePropResult(row.side, row.line, actualValue);
  const units = 1;
  const pl = plUnits(result, units, row.posted_odds);
  // No per-prop dollar stake yet; dollar P/L mirrors the unit P/L 1:1 so the
  // analytics ROI math has a populated field instead of null.
  const plDollars = pl;
  settlePropPick(pickId, { result, actualValue, plUnits: pl, plDollars });
  return { pickId, result, actualValue, plUnits: pl, plDollars };
}
