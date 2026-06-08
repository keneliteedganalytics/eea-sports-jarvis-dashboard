// Generic two-way market builder (spread / total). Devigs both sides via Shin,
// derives a fair line for the chosen side, and tags a tier from the model-vs-fair
// edge. Shared across MLB / NHL / NBA so every card can show ML + spread + total.

import { devigShin, probToAmerican } from "./odds";
import { assignTier } from "./tier";
import { convictionUnits, applyJuicePenalty } from "./sizing";
import { emptyMarket, type Market, type Verdict } from "./types";

export interface TwoWayPrices {
  // side A
  aLabel: string; // e.g. "home", "over"
  aLine: number | null; // handicap or total line for side A
  aPrice: number | null;
  // side B
  bLabel: string;
  bLine: number | null;
  bPrice: number | null;
  book?: string | null;
}

// modelProbA: our projected probability that side A covers/goes over (0..1) or null.
// When null we still surface the devigged fair line but tier stays PASS (no edge).
export function buildTwoWayMarket(
  prices: TwoWayPrices,
  modelProbA: number | null,
  bankroll: number,
  formatPick: (side: "a" | "b", line: number | null, price: number | null) => string,
): Market {
  if (prices.aPrice === null || prices.bPrice === null) return emptyMarket();

  const [fairA, fairB] = devigShin(prices.aPrice, prices.bPrice);
  if (fairA === null || fairB === null) return emptyMarket();

  // Choose the side our model favors; if no model prob, default to the side the
  // market itself prices as more likely (so the displayed pick is coherent).
  let side: "a" | "b";
  if (modelProbA !== null) {
    side = modelProbA >= 0.5 ? "a" : "b";
  } else {
    side = fairA >= fairB ? "a" : "b";
  }

  const sideLabel = side === "a" ? prices.aLabel : prices.bLabel;
  const sideLine = side === "a" ? prices.aLine : prices.bLine;
  const sidePrice = side === "a" ? prices.aPrice : prices.bPrice;
  const fairProb = side === "a" ? fairA : fairB;
  const modelProb = modelProbA === null ? null : side === "a" ? modelProbA : 1 - modelProbA;

  const edgePp = modelProb !== null ? round2((modelProb - fairProb) * 100) : null;

  const tier: Verdict =
    edgePp === null
      ? "PASS"
      : assignTier({
          edgePp,
          confidence: 60, // markets carry a fixed baseline confidence (no 7-component model)
          oddsAmerican: sidePrice,
          winProb: modelProb,
        });

  // EEA flat-unit sizing (SPEC §4): conviction units per tier, juice half-cut.
  const qualifies = ["BONUS", "SNIPER", "EDGE", "RECON", "VALUE"].includes(tier);
  let units = 0;
  if (qualifies && modelProb !== null) {
    units = applyJuicePenalty(convictionUnits(tier), sidePrice).units;
  }

  return {
    available: true,
    pick: formatPick(side, sideLine, sidePrice),
    line: sideLine,
    priceAmerican: sidePrice,
    fairLine: probToAmerican(fairProb),
    edgePp,
    tier,
    units,
    side: sideLabel,
    book: prices.book ?? null,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
