// Probability clamp (v6.6). The ML floor drops to 0.02 so a true long-shot dog
// is no longer forced up to 0.15 (which manufactured phantom edges). Totals and
// spreads keep the tighter [0.30, 0.70] band. Run: tsx server/__tests__/probClamp.test.ts

import assert from "node:assert/strict";
import {
  PROB_CLAMP_LO,
  PROB_CLAMP_HI,
  PROB_CLAMP_TOTALS,
  PROB_CLAMP_SPREADS,
  MODEL_TRUST_WEIGHT,
  MODEL_TRUST_WEIGHT_TOTALS,
  MODEL_TRUST_WEIGHT_SPREADS,
} from "../sports/mlb/model";
import {
  PROB_CLAMP_LO as NHL_LO,
  PROB_CLAMP_HI as NHL_HI,
} from "../sports/nhl/model";
import {
  PROB_CLAMP_LO as NBA_LO,
  PROB_CLAMP_HI as NBA_HI,
} from "../sports/nba/model";

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

// Mirror of the model's clamp step.
function clamp(p: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, p));
}

console.log("probability clamp — v6.6");

test("ML clamp is [0.02, 0.85] across MLB/NHL/NBA", () => {
  assert.equal(PROB_CLAMP_LO, 0.02);
  assert.equal(PROB_CLAMP_HI, 0.85);
  assert.equal(NHL_LO, 0.02);
  assert.equal(NHL_HI, 0.85);
  assert.equal(NBA_LO, 0.02);
  assert.equal(NBA_HI, 0.85);
});

test("a true-3% dog stays at 3% after ML clamp (not forced up to 15%)", () => {
  const trueDog = 0.03;
  const clamped = clamp(trueDog, PROB_CLAMP_LO, PROB_CLAMP_HI);
  assert.equal(clamped, 0.03, `expected 0.03, got ${clamped}`);
  assert.notEqual(clamped, 0.15);
});

test("a true-1% dog is floored at 2% (the new floor), not 15%", () => {
  const clamped = clamp(0.01, PROB_CLAMP_LO, PROB_CLAMP_HI);
  assert.equal(clamped, 0.02);
});

test("upper ceiling still caps at 0.85", () => {
  assert.equal(clamp(0.97, PROB_CLAMP_LO, PROB_CLAMP_HI), 0.85);
});

test("totals clamp is [0.30, 0.70]", () => {
  assert.deepEqual([...PROB_CLAMP_TOTALS], [0.3, 0.7]);
  assert.equal(clamp(0.05, PROB_CLAMP_TOTALS[0], PROB_CLAMP_TOTALS[1]), 0.3);
  assert.equal(clamp(0.95, PROB_CLAMP_TOTALS[0], PROB_CLAMP_TOTALS[1]), 0.7);
});

test("spreads clamp is [0.30, 0.70]", () => {
  assert.deepEqual([...PROB_CLAMP_SPREADS], [0.3, 0.7]);
  assert.equal(clamp(0.1, PROB_CLAMP_SPREADS[0], PROB_CLAMP_SPREADS[1]), 0.3);
});

test("market-specific model trust: ML 0.70, totals 0.45, spreads 0.55", () => {
  assert.equal(MODEL_TRUST_WEIGHT, 0.7);
  assert.equal(MODEL_TRUST_WEIGHT_TOTALS, 0.45);
  assert.equal(MODEL_TRUST_WEIGHT_SPREADS, 0.55);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
