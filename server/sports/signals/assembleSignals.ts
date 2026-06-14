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
  // Model: our projection probability (FRACTION 0..1) for the pick side, + edge.
  pickWinProb: number | null;   // 0..1 (engine emits homeWinProb/awayWinProb)
  edgePp: number | null;        // percentage points vs posted price
  // Market baseline: implied probability (FRACTION 0..1) of the posted price.
  pickImpliedProb: number | null; // 0..1 (engine emits pickFairMkt)
  // Sharp: implied probability from sharp books for the pick side (PERCENT 0-100).
  sharpPct: number | null;
  // Predict: prediction-market win prob for the pick side (PERCENT 0-100).
  predictPct: number | null;
  // Prism inputs: pick-side American line at open and now (for velocity).
  openingLine: number | null;
  currentLine: number | null;
}

// Normalize a 0-100 PERCENT field to a 0..1 probability.
function pctToProb(pct: number | null): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return Math.round((pct / 100) * 1000) / 1000;
}

// Normalize a field that is ALREADY a 0..1 fraction (engine win/implied probs).
// Guards against an accidental 0-100 input by scaling values clearly > 1.
function fracToProb(frac: number | null): number | null {
  if (frac === null || !Number.isFinite(frac)) return null;
  const p = frac > 1 ? frac / 100 : frac;
  return Math.round(p * 1000) / 1000;
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

// Build the MARKET baseline signal (no edge vs itself). pickImpliedProb is a
// 0..1 fraction from the engine, so do NOT divide by 100.
function marketSignal(f: SignalSourceFields): Signal | null {
  const prob = fracToProb(f.pickImpliedProb);
  if (prob === null) return null;
  return { prob, edgePp: 0, side: f.pickSide };
}

// MODEL is our projection. pickWinProb is a 0..1 fraction from the engine, so do
// NOT divide by 100.
function modelSignal(f: SignalSourceFields): Signal | null {
  const prob = fracToProb(f.pickWinProb);
  if (prob === null && f.edgePp === null) return null;
  return { prob, edgePp: f.edgePp ?? null, side: f.pickSide };
}

function sharpSignal(f: SignalSourceFields): Signal | null {
  const prob = pctToProb(f.sharpPct);
  if (prob === null) return null;
  return { prob, edgePp: edgeVsMarket(prob, fracToProb(f.pickImpliedProb)), side: f.pickSide };
}

function predictSignal(f: SignalSourceFields): Signal | null {
  const prob = pctToProb(f.predictPct);
  if (prob === null) return null;
  return { prob, edgePp: edgeVsMarket(prob, fracToProb(f.pickImpliedProb)), side: f.pickSide };
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

// v6.9.1 — prop-surface adapter. A prop pick exposes a different field set than a
// game line, so we map it onto SignalSourceFields and reuse the same serializer:
//   market  ← implied prob of the posted (or best-book) price for the pick side
//   model   ← the simulator's projected hit rate (model_prob, already 0..1)
//   prism   ← posted→closing odds velocity on the pick side
//   sharp   ← null (no distinct sharp-book prop feed yet)
//   predict ← null (prediction markets don't price player props)
export interface PropSignalSourceFields {
  side: "over" | "under" | null;
  modelProb: number | null;       // 0..1 simulator hit rate
  edgePp: number | null;          // pp vs posted price
  postedOdds: number | null;      // American, the price we took
  bestPrice: number | null;       // American, best-book fallback for market baseline
  closingOdds: number | null;     // American, for prism velocity
}

export function assemblePropSignals(p: PropSignalSourceFields): PickSignals {
  const marketAmerican = p.postedOdds ?? p.bestPrice;
  const marketProb = americanToProb(marketAmerican);
  return assembleSignals({
    pickSide: p.side,
    pickWinProb: p.modelProb,
    edgePp: p.edgePp,
    pickImpliedProb: marketProb, // already a 0..1 fraction → fracToProb keeps it
    sharpPct: null,
    predictPct: null,
    openingLine: p.postedOdds,   // open→close velocity uses the price we took as "open"
    currentLine: p.closingOdds,
  });
}
