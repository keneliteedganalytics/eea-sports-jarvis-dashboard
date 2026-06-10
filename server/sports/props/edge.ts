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

export interface PropEdgeResult {
  side: "over" | "under";
  modelProb: number; // model probability for the chosen side
  probOver: number;
  probUnder: number;
  pushProb: number;
  bestBook: string;
  bestPrice: number;
  impliedProb: number; // de-vigged not applied — raw implied from best price
  edgePp: number; // (modelProb − impliedProb) × 100
}

// Pick the side the model favors (higher model prob), shop its best price, and
// compute the edge in pp. Returns null when neither side has a priced book.
export function computePropEdge(
  dist: SimDistribution,
  line: number,
  quotes: BookQuote[],
): PropEdgeResult | null {
  const ou = overUnderProb(dist, line);
  const side: "over" | "under" = ou.probOver >= ou.probUnder ? "over" : "under";
  const modelProb = side === "over" ? ou.probOver : ou.probUnder;

  const best = bestPriceForSide(quotes, side);
  if (!best) return null;

  const implied = americanToProb(best.price);
  if (implied === null) return null;

  const edgePp = round2((modelProb - implied) * 100);
  return {
    side,
    modelProb,
    probOver: ou.probOver,
    probUnder: ou.probUnder,
    pushProb: ou.pushProb,
    bestBook: best.book,
    bestPrice: best.price,
    impliedProb: round4(implied),
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
