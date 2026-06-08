// Prop edge model. MLB headline props get a Poisson over/under fair probability
// from a per-PA (or per-game) rate × expected opportunities. NHL/NBA props are
// day-1 display-only (uncalibrated) until a per-player rate feed is wired.

import { assignTier } from "../core/tier";
import { probToAmerican, americanToProb } from "../core/odds";
import type { Verdict } from "../core/types";

// Poisson P(X >= k) for mean lambda.
export function poissonTailGe(lambda: number, k: number): number {
  if (lambda <= 0) return k <= 0 ? 1 : 0;
  // P(X >= k) = 1 - P(X <= k-1)
  let cdf = 0;
  let term = Math.exp(-lambda); // P(X = 0)
  for (let i = 0; i < k; i++) {
    if (i > 0) term *= lambda / i;
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

export interface PropEdge {
  modelProb: number | null; // P(over the line)
  fairOverAmerican: number | null;
  edgePp: number | null; // model over-prob minus devigged market over-prob
  tier: Verdict | null;
  side: "over" | "under" | null;
  uncalibrated: boolean;
}

// MLB Poisson edge: lambda = perOpportunityRate × expectedOpportunities. The
// over line for a 0.5 book line resolves as P(X >= 1).  e.g. HR rate .080 ×
// 4.3 PA ≈ .344 → fair over ≈ -52.
export function mlbPropEdge(
  perOppRate: number | null,
  expectedOpportunities: number | null,
  line: number,
  overPrice: number | null,
  underPrice: number | null,
): PropEdge {
  if (perOppRate === null || expectedOpportunities === null || perOppRate <= 0 || expectedOpportunities <= 0) {
    return { modelProb: null, fairOverAmerican: null, edgePp: null, tier: null, side: null, uncalibrated: true };
  }
  const lambda = perOppRate * expectedOpportunities;
  // SPEC §10: for the headline 0.5 line, the projected count (rate × opps) is
  // used directly as the over probability (e.g. HR .080 × 4.3 ≈ .344). For
  // higher lines we fall back to the Poisson tail P(X >= ceil(line)).
  const overProb = line <= 0.5 ? Math.max(0, Math.min(1, lambda)) : poissonTailGe(lambda, Math.ceil(line));

  let marketOver: number | null = null;
  if (overPrice !== null && underPrice !== null) {
    const po = americanToProb(overPrice);
    const pu = americanToProb(underPrice);
    if (po !== null && pu !== null && po + pu > 0) marketOver = po / (po + pu);
  }

  const edgePp = marketOver !== null ? round2((overProb - marketOver) * 100) : null;
  const side: "over" | "under" = edgePp !== null && edgePp < 0 ? "under" : "over";
  const sideEdge = side === "over" ? edgePp : edgePp !== null ? -edgePp : null;

  const tier: Verdict | null =
    sideEdge === null
      ? null
      : assignTier({ edgePp: sideEdge, confidence: 55, oddsAmerican: side === "over" ? overPrice : underPrice, winProb: side === "over" ? overProb : 1 - overProb });

  return {
    modelProb: round4(overProb),
    fairOverAmerican: probToAmerican(overProb),
    edgePp: sideEdge !== null ? round2(sideEdge) : null,
    tier,
    side,
    uncalibrated: false,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
