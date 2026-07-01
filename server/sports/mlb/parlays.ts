// v6.14.0 — correlation-aware parlay builder. Once the daily card is locked we
// assemble 2- and 3-leg parlays from the card's own picks. The rules are
// deliberately conservative: never combine two legs from the same game, and
// penalize positively-correlated legs (e.g. two Overs on the same day) so we
// don't stack variance. A parlay only surfaces when its edge clears +3.0pp and
// its stake is hard-capped at 0.5u regardless of edge (thin liquidity, high
// variance). Everything here is pure + deterministic so it unit-tests cleanly.

import {
  americanToDecimal,
  americanToProb,
  decimalToAmerican,
  probToAmerican,
} from "../../core/odds";
import type { CardPick } from "../../core/dailyCard";

// Minimum edge (pp) a parlay must clear before we surface it.
export const PARLAY_MIN_EDGE_PP = 3.0;
// Hard stake cap for any parlay (units), regardless of computed edge.
export const PARLAY_MAX_UNITS = 0.5;
// Penalty applied to the combined win prob when two legs are positively
// correlated (same-day, both Overs). Shrinks the fair prob toward the book.
export const PARLAY_CORR_PENALTY = 0.9;

export interface ParlayLeg {
  gameId: string;
  matchup: string;
  market: string;
  selection: string;
  priceAmerican: number;
  winProb: number;
}

export interface Parlay {
  legs: ParlayLeg[];
  combinedWinProb: number; // product of leg probs, after correlation penalty
  fairAmerican: number | null;
  bookAmerican: number | null; // product of leg decimals → american
  parlayEdgePp: number;
  units: number;
  correlationNote: string | null;
}

function isOver(pick: CardPick): boolean {
  return pick.market === "Total" && /^over/i.test(pick.selection);
}

// Pairwise correlation heuristic (0 = independent, 1 = identical/blocked):
//   • same game            → 1.0 (never combine)
//   • same day, both Overs → 0.3 (positively correlated, penalize)
//   • otherwise            → 0.0
export function legCorrelation(a: CardPick, b: CardPick): number {
  if (a.gameId === b.gameId) return 1.0;
  if (a.gameDate === b.gameDate && isOver(a) && isOver(b)) return 0.3;
  return 0.0;
}

function toLeg(p: CardPick): ParlayLeg | null {
  if (p.priceAmerican === null || p.winProb === null) return null;
  return {
    gameId: p.gameId,
    matchup: p.matchup,
    market: p.market,
    selection: p.selection,
    priceAmerican: p.priceAmerican,
    winProb: p.winProb,
  };
}

// Build one parlay from a set of card picks. Returns null when the combination
// is invalid (same-game legs, unpriceable legs, or edge below the floor).
export function buildParlay(picks: CardPick[]): Parlay | null {
  const legs: ParlayLeg[] = [];
  for (const p of picks) {
    const leg = toLeg(p);
    if (!leg) return null;
    legs.push(leg);
  }
  if (legs.length < 2) return null;

  // Correlation scan across every pair. Same-game blocks the parlay outright;
  // a positive correlation flags the variance penalty.
  let penalized = false;
  let correlationNote: string | null = null;
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const c = legCorrelation(picks[i], picks[j]);
      if (c >= 1.0) return null; // same game — never combine
      if (c > 0) {
        penalized = true;
        correlationNote = "same-day Overs — variance penalty applied";
      }
    }
  }

  // Fair combined prob = product of leg win probs, shrunk if correlated.
  let combined = legs.reduce((acc, l) => acc * l.winProb, 1);
  if (penalized) combined *= PARLAY_CORR_PENALTY;

  // Book parlay price = product of leg decimal prices.
  let bookDecimal = 1;
  for (const l of legs) {
    const d = americanToDecimal(l.priceAmerican);
    if (d === null) return null;
    bookDecimal *= d;
  }
  const bookAmerican = decimalToAmerican(bookDecimal);
  const bookImpliedProb = americanToProb(bookAmerican);

  const fairAmerican = probToAmerican(combined);
  const parlayEdgePp =
    bookImpliedProb !== null ? (combined - bookImpliedProb) * 100 : 0;

  if (parlayEdgePp < PARLAY_MIN_EDGE_PP) return null;

  return {
    legs,
    combinedWinProb: Math.round(combined * 1e4) / 1e4,
    fairAmerican,
    bookAmerican,
    parlayEdgePp: Math.round(parlayEdgePp * 10) / 10,
    units: PARLAY_MAX_UNITS,
    correlationNote,
  };
}

// Build the day's parlay slate from the locked card picks: the best 2-leg and,
// when a third non-conflicting leg is available, the best 3-leg. Picks are
// assumed pre-sorted by edge DESC (the daily card selection order).
export function buildParlays(cardPicks: CardPick[]): Parlay[] {
  const out: Parlay[] = [];
  const eligible = cardPicks.filter((p) => p.priceAmerican !== null && p.winProb !== null);
  if (eligible.length < 2) return out;

  // 2-leg: highest-edge pair from different games.
  const two = pickTopUncorrelated(eligible, 2);
  const twoLeg = two ? buildParlay(two) : null;
  if (twoLeg) out.push(twoLeg);

  // 3-leg: highest-edge trio from different games.
  if (eligible.length >= 3) {
    const three = pickTopUncorrelated(eligible, 3);
    const threeLeg = three ? buildParlay(three) : null;
    if (threeLeg) out.push(threeLeg);
  }
  return out;
}

// Greedily take the top-N picks (already edge-sorted) whose games don't collide.
function pickTopUncorrelated(picks: CardPick[], n: number): CardPick[] | null {
  const chosen: CardPick[] = [];
  const seenGames = new Set<string>();
  for (const p of picks) {
    if (seenGames.has(p.gameId)) continue;
    chosen.push(p);
    seenGames.add(p.gameId);
    if (chosen.length === n) break;
  }
  return chosen.length === n ? chosen : null;
}
