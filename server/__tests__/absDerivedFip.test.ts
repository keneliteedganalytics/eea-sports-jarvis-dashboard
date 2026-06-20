// Fix 3: derivedFipPenalty — framing-runs-saved → FIP penalty.
// Tests: bad framer + framing-dependent SP → big penalty;
//        good framer + same SP → near-zero;
//        ABS opt-out (exposurePct=0) → zero;
//        backward compat: absFipPenalty still works unchanged.
// Run: tsx server/__tests__/absDerivedFip.test.ts

import assert from "node:assert/strict";
import {
  derivedFipPenalty,
  absFipPenalty,
  DERIVED_FIP_PENALTY_CAP,
  IP_PER_START_AVG,
  FRAMING_FIP_WEIGHT,
} from "../sports/mlb/abs";

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

console.log("Fix 3 — derivedFipPenalty (FRS-based ABS penalty)");

test("ABS opt-out (exposurePct=0) → zero penalty regardless of catcher FRS", () => {
  assert.equal(derivedFipPenalty(0, 5), 0);
  assert.equal(derivedFipPenalty(0, -5), 0);
  assert.equal(derivedFipPenalty(0, 0), 0);
});

test("good framer (catcherFRS > 0) + full exposure → positive penalty", () => {
  // catcherFRS=5 means catcher was saving 5 runs/162G → pitcher loses that under ABS
  const penalty = derivedFipPenalty(1.0, 5);
  // Expected: 1.0 * (5/162) * 9 / 5.5 ≈ 0.101
  const expected = Math.round(1.0 * (5 / 162) * 9 / IP_PER_START_AVG * 100) / 100;
  assert.ok(penalty > 0, `expected positive penalty for good framer, got ${penalty}`);
  assert.equal(penalty, expected);
});

test("bad framer (catcherFRS < 0) → near-zero penalty (framer provided no edge)", () => {
  const penalty = derivedFipPenalty(1.0, -5);
  assert.equal(penalty, 0, `expected 0 for bad framer, got ${penalty}`);
});

test("neutral framer (catcherFRS=0) → zero penalty", () => {
  assert.equal(derivedFipPenalty(1.0, 0), 0);
});

test("penalty caps at DERIVED_FIP_PENALTY_CAP (+0.40)", () => {
  // Very high catcherFRS to force cap: catcherFRS=1000
  const penalty = derivedFipPenalty(1.0, 1000);
  assert.equal(penalty, DERIVED_FIP_PENALTY_CAP);
});

test("partial ABS exposure reduces penalty proportionally", () => {
  const full = derivedFipPenalty(1.0, 4);
  const half = derivedFipPenalty(0.5, 4);
  assert.ok(
    Math.abs(half - full / 2) < 0.005,
    `half-exposure should be ≈ half of full-exposure penalty (full=${full}, half=${half})`,
  );
});

test("absFipPenalty backward compat: unchanged for dep=1", () => {
  assert.equal(absFipPenalty(1), FRAMING_FIP_WEIGHT);
});

test("absFipPenalty backward compat: unchanged for dep=0", () => {
  assert.equal(absFipPenalty(0), 0);
});

test("absFipPenalty backward compat: dep>1 clamped to FRAMING_FIP_WEIGHT", () => {
  assert.equal(absFipPenalty(2), FRAMING_FIP_WEIGHT);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
