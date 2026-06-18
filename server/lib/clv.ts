// Closing Line Value (CLV) math. Pure functions — no DB, no network.
// CLV measures whether the price we posted beat the closing line. The sign
// convention used everywhere: POSITIVE CLV = we beat the close (our posted
// price was better than where the market settled).

export function americanToImpliedProb(odds: number): number {
  if (odds === 0) return 0;
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

export function americanToDecimal(odds: number): number {
  if (odds === 0) return 1;
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds;
}

export interface ClvResult {
  clvPoints: number; // implied-probability points; positive = beat the close
  clvPercent: number; // percent change in decimal odds; positive = beat the close
}

// clvPoints: we beat the close when our posted price carried a LOWER implied
// probability (a better number / lower break-even) than the closing price.
// closingProb − postedProb is therefore positive exactly when we beat the close.
// clvPercent: how much more our posted decimal price pays vs the closing price.
export function computeClv(postedOdds: number, closingOdds: number): ClvResult {
  const postedProb = americanToImpliedProb(postedOdds);
  const closingProb = americanToImpliedProb(closingOdds);
  const clvPoints = (closingProb - postedProb) * 100;

  const postedDec = americanToDecimal(postedOdds);
  const closingDec = americanToDecimal(closingOdds);
  const clvPercent = (postedDec / closingDec - 1) * 100;

  return { clvPoints: round2(clvPoints), clvPercent: round2(clvPercent) };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// Sport-specific copy for the "lock window opens at …" chip shown before a
// pick's closing line is captured.
export function lockLabelForSport(sport: string): string {
  switch (sport) {
    case "mlb":
      return "Lock at first pitch";
    case "nba":
      return "Lock at tip";
    case "nhl":
      return "Lock at puck drop";
    default:
      return "Lock at start";
  }
}
