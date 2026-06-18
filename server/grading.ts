// Pure grading helpers — given a pick's market (ML / spread / total) and a final
// score, decide the result (W/L/P) and the profit/loss in units. No I/O here so
// the rules are trivially testable.

export type Side = "home" | "away";
export type Result = "W" | "L" | "P";

// Profit/loss in units for a settled bet at American odds.
//   win  → units * (ml > 0 ? ml/100 : 100/|ml|)
//   loss → -units
//   push → 0
export function plUnits(result: Result, units: number, ml: number | null): number {
  if (result === "P") return 0;
  if (result === "L") return -units;
  // win
  const odds = ml ?? 100; // even money fallback
  const mult = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  return round2(units * mult);
}

// Moneyline: the side with more runs/goals/points wins; equal final = push.
export function gradeMoneyline(pickSide: Side, awayScore: number, homeScore: number): Result {
  if (awayScore === homeScore) return "P";
  const winner: Side = homeScore > awayScore ? "home" : "away";
  return winner === pickSide ? "W" : "L";
}

// Spread: apply the pick's line to the picked side's score. A negative line is
// laid (favorite), positive is taken (underdog). Exact landing = push.
export function gradeSpread(pickSide: Side, line: number, awayScore: number, homeScore: number): Result {
  const picked = pickSide === "away" ? awayScore : homeScore;
  const other = pickSide === "away" ? homeScore : awayScore;
  const adjusted = picked + line;
  if (adjusted === other) return "P";
  return adjusted > other ? "W" : "L";
}

// Total: sum vs the posted line. side "over" wins above the line, "under" below;
// exact landing = push.
export function gradeTotal(side: "over" | "under", line: number, awayScore: number, homeScore: number): Result {
  const sum = awayScore + homeScore;
  if (sum === line) return "P";
  const isOver = sum > line;
  return (side === "over") === isOver ? "W" : "L";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
