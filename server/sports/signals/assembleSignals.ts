// v6.9.0 — assemble a pick's five-source PickSignals at the serialization layer.
//
// This is PURE + ADDITIVE: it reads fields already present on a built pick and
// produces a PickSignals object for the API/UI. It does NOT feed the tier engine
// (the strict SNIPER gate stays SHADOW-only per signalAgreementForSniper), so
// attaching signals changes no live pick behavior — it only exposes the reads.
//
// Mapping (per v6.9.0 directive):
//   market  ← posted line / consensus implied prob (pickImpliedProb)
//   sharp   ← sharp-book implied prob (sharpPct), oriented to the pick side
//   model   ← our projection win prob (pickWinProb) + edgePp
//   predict ← prediction-market pct (polymarket/Kalshi), oriented to pick side
//   prism   ← line-velocity read: opening→current line movement on our side
//
// Every source degrades to null when its input is absent, so a pick with only a
// model read yields { model, …: null } and the degraded gate still applies.

import type { PickSignals, Signal } from "../../../shared/types/signals";

// The minimal pick shape this serializer needs. A superset of these fields lives
// on BuiltPick (game lines); props pass an adapted subset. Kept structural so it
// works across surfaces without importing the heavyweight engine types.
export interface SignalSourceFields {
  pickSide: "home" | "away" | "over" | "under" | null;
  // Model: our projection probability (0-100) for the pick side, and its edge.
  pickWinProb: number | null;   // 0-100
  edgePp: number | null;        // percentage points vs posted price
  // Market baseline: implied probability of the posted price for the pick side.
  pickImpliedProb: number | null; // 0-100
  // Sharp: implied probability from sharp books for the pick side (0-100).
  sharpPct: number | null;
  // Predict: prediction-market win prob for the pick side (0-100).
  predictPct: number | null;
  // Prism inputs: pick-side American line at open and now (for velocity).
  openingLine: number | null;
  currentLine: number | null;
}

function pctToProb(pct: number | null): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return Math.round((pct / 100) * 1000) / 1000;
}

// American odds → implied probability (0..1), de-vig-free (raw).
function americanToProb(american: number | null): number | null {
  if (american === null || !Number.isFinite(american) || american === 0) return null;
  const p = american > 0 ? 100 / (american + 100) : -american / (-american + 100);
  return Math.round(p * 1000) / 1000;
}

function edgeVsMarket(prob: number | null, marketProb: number | null): number | null {
  if (prob === null || marketProb === null) return null;
  return Math.round((prob - marketProb) * 1000) / 10; // pp, 1 decimal
}

// Build the MARKET baseline signal (no edge vs itself).
function marketSignal(f: SignalSourceFields): Signal | null {
  const prob = pctToProb(f.pickImpliedProb);
  if (prob === null) return null;
  return { prob, edgePp: 0, side: f.pickSide };
}

function modelSignal(f: SignalSourceFields): Signal | null {
  const prob = pctToProb(f.pickWinProb);
  if (prob === null && f.edgePp === null) return null;
  return { prob, edgePp: f.edgePp ?? null, side: f.pickSide };
}

function sharpSignal(f: SignalSourceFields): Signal | null {
  const prob = pctToProb(f.sharpPct);
  if (prob === null) return null;
  return { prob, edgePp: edgeVsMarket(prob, pctToProb(f.pickImpliedProb)), side: f.pickSide };
}

function predictSignal(f: SignalSourceFields): Signal | null {
  const prob = pctToProb(f.predictPct);
  if (prob === null) return null;
  return { prob, edgePp: edgeVsMarket(prob, pctToProb(f.pickImpliedProb)), side: f.pickSide };
}

// PRISM = line velocity. We translate the open→current move on the pick side into
// an implied-probability shift; a line getting shorter (more negative / less
// plus) means the market moved TOWARD our side → positive prism edge.
function prismSignal(f: SignalSourceFields): Signal | null {
  const openP = americanToProb(f.openingLine);
  const nowP = americanToProb(f.currentLine);
  if (openP === null || nowP === null) return null;
  const movePp = Math.round((nowP - openP) * 1000) / 10; // +pp = market moved to us
  // Prism's "prob" is the current market-implied prob (its best estimate of true
  // win %); its edge is the velocity (how far it moved toward our side).
  return { prob: nowP, edgePp: movePp, side: f.pickSide };
}

// Assemble all five sources. Pure; any absent input yields a null source.
export function assembleSignals(f: SignalSourceFields): PickSignals {
  return {
    market: marketSignal(f),
    sharp: sharpSignal(f),
    model: modelSignal(f),
    prism: prismSignal(f),
    predict: predictSignal(f),
  };
}
