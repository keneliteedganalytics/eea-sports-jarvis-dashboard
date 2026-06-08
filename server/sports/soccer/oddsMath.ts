// Soccer odds math helpers: 3-way devig and Asian handicap parser.
// Re-exports devigThreeWay from core/odds and adds soccer-specific helpers.

export { devigThreeWay, type ThreeWayFair } from "../../core/odds";

// ── Asian handicap parser ─────────────────────────────────────────────────────
// Asian handicap lines look like: "0", "-0.5", "+1", "-1.5", "+0.25", "-0.75"
// Quarter lines (0.25, 0.75) split the stake across two lines.

export interface AsianHandicapLine {
  line: number;   // e.g. -0.5
  isQuarter: boolean; // true for 0.25 / 0.75 splits
  splitLines?: [number, number]; // e.g. [0, -0.5] for -0.25 line
  displayStr: string; // e.g. "-0.5" or "0 / -0.5"
}

/**
 * Parse an Asian handicap point string into a structured line.
 * Accepts: "0", "-0.5", "+1.5", "-0.25", "+0.75", etc.
 */
export function parseAsianHandicap(raw: string | number): AsianHandicapLine {
  const v = typeof raw === "number" ? raw : parseFloat(String(raw).replace("+", ""));
  if (Number.isNaN(v)) {
    return { line: 0, isQuarter: false, displayStr: "0" };
  }

  const abs = Math.abs(v);
  const frac = abs % 1;
  const isQuarter = Math.abs(frac - 0.25) < 0.01 || Math.abs(frac - 0.75) < 0.01;

  if (!isQuarter) {
    return {
      line: v,
      isQuarter: false,
      displayStr: v > 0 ? `+${v}` : `${v}`,
    };
  }

  // Quarter-line: rounds to neighbouring half-lines
  const sign = v < 0 ? -1 : 1;
  const lower = sign * (Math.floor(abs * 2) / 2);
  const upper = sign * (Math.ceil(abs * 2) / 2);

  const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return {
    line: v,
    isQuarter: true,
    splitLines: [lower, upper],
    displayStr: `${fmtLine(lower)} / ${fmtLine(upper)}`,
  };
}

/**
 * Extract the h2h draw odds from the Odds API raw bookmakers for a soccer event.
 * Looks for an outcome named "Draw" in the h2h market.
 */
export function extractDrawOdds(
  rawBookmakers: Array<{
    key?: string;
    title?: string;
    markets?: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number }>;
    }>;
  }>,
): number | null {
  const prices: number[] = [];
  for (const bm of rawBookmakers) {
    const h2h = bm.markets?.find((m) => m.key === "h2h");
    if (!h2h) continue;
    const draw = h2h.outcomes.find(
      (o) => o.name.toLowerCase() === "draw",
    );
    if (draw?.price !== undefined) prices.push(draw.price);
  }
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? Math.round(sorted[mid])
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
