// Prop edge calculation. Turns a simulated distribution + a real posted line and
// price into a model probability, the best-available price across books, and the
// edge in percentage points.
//
// Over/under from the distribution: count trials strictly above the line for the
// over, strictly below for the under. Trials EXACTLY on the line are pushes —
// for a whole-number line we split them as half to each side (a push on the bet
// returns the stake, so it's neither a win nor a loss; counting it as half-over
// is the standard convention for turning a discrete sim into an over/under prob).

import { americanToProb } from "../../core/odds";
import type { SimDistribution } from "./simulate";

export interface OverUnderProb {
  probOver: number;
  probUnder: number;
  pushProb: number; // share of trials exactly on the line
}

// Compute P(over), P(under), P(push) from the sorted samples vs a line.
export function overUnderProb(dist: SimDistribution, line: number): OverUnderProb {
  const n = dist.samples.length;
  if (n === 0) return { probOver: 0, probUnder: 0, pushProb: 0 };
  let above = 0;
  let below = 0;
  let on = 0;
  for (const s of dist.samples) {
    if (s > line) above++;
    else if (s < line) below++;
    else on++;
  }
  // Half-push: split exact-line trials evenly between over and under.
  const probOver = (above + on / 2) / n;
  const probUnder = (below + on / 2) / n;
  return {
    probOver: round4(probOver),
    probUnder: round4(probUnder),
    pushProb: round4(on / n),
  };
}

export interface BookQuote {
  book: string;
  overPrice: number | null;
  underPrice: number | null;
}

export interface BestPrice {
  book: string;
  price: number; // American
}

// Best (highest, i.e. most favorable to the bettor) price for a side across books.
export function bestPriceForSide(quotes: BookQuote[], side: "over" | "under"): BestPrice | null {
  let best: BestPrice | null = null;
  for (const q of quotes) {
    const price = side === "over" ? q.overPrice : q.underPrice;
    if (price === null || price === undefined) continue;
    if (best === null || price > best.price) best = { book: q.book, price };
  }
  return best;
}

export interface FairQuote {
  book: string;
  fairProb: number; // de-vigged fair probability for the picked side at this book
  price: number; // the American price at this book for the picked side
}

// No-vig (devigged) fair probability for one side at one book. When BOTH the
// over and under price are present we remove the bookmaker margin by normalizing:
//   total = rawOver + rawUnder (> 1 due to vig)
//   fairProb = rawSide / total
// When only the picked side is priced, no two-way market exists to devig against,
// so we fall back to the raw single-side implied probability. Returns null when
// the picked side has no price.
export function fairProbForQuote(q: BookQuote, side: "over" | "under"): number | null {
  const rawOver = q.overPrice == null ? null : americanToProb(q.overPrice);
  const rawUnder = q.underPrice == null ? null : americanToProb(q.underPrice);
  const rawSide = side === "over" ? rawOver : rawUnder;
  if (rawSide === null) return null;
  if (rawOver !== null && rawUnder !== null) {
    const total = rawOver + rawUnder;
    if (total <= 0) return null;
    return rawSide / total;
  }
  // Single-side market: no opposing price to devig against — use raw implied.
  return rawSide;
}

// Line-shop on the BEST (lowest) fair market probability for the picked side
// across books — the lowest fair prob is the cheapest bet after vig, i.e. the
// most edge. Carries the book and its American price (for display) alongside.
// Returns null when no book prices the picked side.
export function bestFairForSide(quotes: BookQuote[], side: "over" | "under"): FairQuote | null {
  let best: FairQuote | null = null;
  for (const q of quotes) {
    const fair = fairProbForQuote(q, side);
    if (fair === null) continue;
    const price = side === "over" ? q.overPrice : q.underPrice;
    if (price === null || price === undefined) continue;
    if (best === null || fair < best.fairProb) best = { book: q.book, fairProb: fair, price };
  }
  return best;
}

export interface PropEdgeResult {
  side: "over" | "under";
  modelProb: number; // model probability for the chosen side
  probOver: number;
  probUnder: number;
  pushProb: number;
  bestBook: string;
  bestPrice: number;
  impliedProb: number; // de-vigged fair market prob the edge is computed against
  edgePp: number; // (modelProb − fairMarketProb) × 100
}

// Pick the side the model favors (higher model prob), shop the book with the best
// (lowest) no-vig fair market prob for that side, and compute the edge against
// that fair prob in pp. Returns null when neither side has a priced book.
export function computePropEdge(
  dist: SimDistribution,
  line: number,
  quotes: BookQuote[],
): PropEdgeResult | null {
  const ou = overUnderProb(dist, line);
  const side: "over" | "under" = ou.probOver >= ou.probUnder ? "over" : "under";
  const modelProb = side === "over" ? ou.probOver : ou.probUnder;

  const best = bestFairForSide(quotes, side);
  if (!best) return null;

  const edgePp = round2((modelProb - best.fairProb) * 100);
  return {
    side,
    modelProb,
    probOver: ou.probOver,
    probUnder: ou.probUnder,
    pushProb: ou.pushProb,
    bestBook: best.book,
    bestPrice: best.price,
    impliedProb: round4(best.fairProb),
    edgePp,
  };
}

// Edge surfacing gate (spec §3): edge ≥ 4.0pp AND model_prob ≥ 0.50 AND
// data quality not LOW. Pure predicate so it's unit-testable.
export const PROP_EDGE_FLOOR_PP = 4.0;
export const PROP_MIN_MODEL_PROB = 0.5;

export function qualifiesAsPick(
  edge: PropEdgeResult,
  dataQualityTier: string,
): boolean {
  if (dataQualityTier.toUpperCase() === "LOW") return false;
  return edge.edgePp >= PROP_EDGE_FLOOR_PP && edge.modelProb >= PROP_MIN_MODEL_PROB;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
