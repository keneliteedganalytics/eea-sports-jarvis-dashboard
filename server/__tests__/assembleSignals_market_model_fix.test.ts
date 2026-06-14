// v6.9.1 — BUG 1 regression guard. Before the fix, marketSignal/modelSignal ran
// the engine's already-fractional pickImpliedProb/pickWinProb through a /100, so
// MARKET and MODEL came out ~100x too small (0.004 instead of 0.4) while SHARP,
// PRISM and PREDICT were correct. This asserts that for a realistic +106 dog the
// MARKET and MODEL probs land in the SAME order of magnitude as SHARP/PRISM —
// i.e. all five usable sources are > 0.10 — and that none of them is the tell-
// tale 100x-shrunk value. Pure, no network.
// Run: tsx server/__tests__/assembleSignals_market_model_fix.test.ts

import assert from "node:assert/strict";
import {
  assembleSignals,
  type SignalSourceFields,
} from "../sports/signals/assembleSignals";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("v6.9.1 — assembleSignals MARKET/MODEL magnitude fix");

// A realistic +106 dog (PHI @ MIL home in the user's report): the engine emits
// fractional model/implied probs (~0.49 fair market, ~0.49 model), sharp/predict
// come in as 0-100 percents, and the line has crept toward our side.
const dog: SignalSourceFields = {
  pickSide: "home",
  pickWinProb: 0.49,      // 0..1 fraction
  edgePp: 1.5,
  pickImpliedProb: 0.485, // 0..1 fraction (+106 ≈ 48.5%)
  sharpPct: 47.8,         // 0-100 percent
  predictPct: 47.5,       // 0-100 percent
  openingLine: 100,
  currentLine: 106,
};

test("MARKET and MODEL are in the same magnitude as SHARP and PRISM (> 0.10)", () => {
  const s = assembleSignals(dog);
  assert.ok(s.market && s.model && s.sharp && s.prism, "all four sources present");
  assert.ok(s.market!.prob! > 0.1, `MARKET too small: ${s.market!.prob}`);
  assert.ok(s.model!.prob! > 0.1, `MODEL too small: ${s.model!.prob}`);
  assert.ok(s.sharp!.prob! > 0.1, `SHARP unexpectedly small: ${s.sharp!.prob}`);
  assert.ok(s.prism!.prob! > 0.1, `PRISM unexpectedly small: ${s.prism!.prob}`);
});

test("MARKET maps straight from the fractional pickImpliedProb (no /100)", () => {
  const s = assembleSignals(dog);
  assert.equal(s.market!.prob, 0.485);
});

test("MODEL maps straight from the fractional pickWinProb (no /100)", () => {
  const s = assembleSignals(dog);
  assert.equal(s.model!.prob, 0.49);
});

test("MARKET/MODEL are not the 100x-shrunk values (regression on the old bug)", () => {
  const s = assembleSignals(dog);
  assert.ok(s.market!.prob! > 0.05, `MARKET shows the old bug: ${s.market!.prob}`);
  assert.ok(s.model!.prob! > 0.05, `MODEL shows the old bug: ${s.model!.prob}`);
});

test("all five usable sources cluster (max/min ratio < 2) for a near-coinflip dog", () => {
  const s = assembleSignals(dog);
  const probs = [s.market!.prob!, s.model!.prob!, s.sharp!.prob!, s.prism!.prob!, s.predict!.prob!];
  const hi = Math.max(...probs);
  const lo = Math.min(...probs);
  assert.ok(hi / lo < 2, `sources not clustered: ${JSON.stringify(probs)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
