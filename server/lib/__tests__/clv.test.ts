// CLV math: conversions + sign convention (positive = beat the close).
// Run: tsx server/lib/__tests__/clv.test.ts

import assert from "node:assert/strict";
import {
  americanToImpliedProb,
  americanToDecimal,
  computeClv,
  lockLabelForSport,
} from "../clv";

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

const close = (a: number, b: number, eps = 0.01) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

console.log("CLV math");

// ── conversions ─────────────────────────────────────────────────────
test("americanToImpliedProb: -110 ≈ 0.5238", () => {
  close(americanToImpliedProb(-110), 0.5238);
});
test("americanToImpliedProb: +120 ≈ 0.4545", () => {
  close(americanToImpliedProb(120), 0.4545);
});
test("americanToImpliedProb: +100 = 0.5", () => {
  close(americanToImpliedProb(100), 0.5);
});
test("americanToDecimal: -110 ≈ 1.909", () => {
  close(americanToDecimal(-110), 1.909);
});
test("americanToDecimal: +120 = 2.20", () => {
  close(americanToDecimal(120), 2.2);
});
test("americanToDecimal: +100 = 2.0", () => {
  close(americanToDecimal(100), 2.0);
});

// ── CLV sign convention (positive = beat the close) ─────────────────
test("pick -110 vs close -120 → positive CLV", () => {
  const r = computeClv(-110, -120);
  assert.ok(r.clvPoints > 0, `clvPoints ${r.clvPoints} should be > 0`);
  assert.ok(r.clvPercent > 0, `clvPercent ${r.clvPercent} should be > 0`);
  close(r.clvPoints, 2.16, 0.05);
  close(r.clvPercent, 4.15, 0.1);
});
test("pick +120 vs close +110 → positive CLV", () => {
  const r = computeClv(120, 110);
  assert.ok(r.clvPoints > 0, `clvPoints ${r.clvPoints} should be > 0`);
  assert.ok(r.clvPercent > 0, `clvPercent ${r.clvPercent} should be > 0`);
});
test("pick -110 vs close -100 → negative CLV", () => {
  const r = computeClv(-110, -100);
  assert.ok(r.clvPoints < 0, `clvPoints ${r.clvPoints} should be < 0`);
  assert.ok(r.clvPercent < 0, `clvPercent ${r.clvPercent} should be < 0`);
});
test("even money: +100 vs +100 → zero CLV", () => {
  const r = computeClv(100, 100);
  assert.equal(r.clvPoints, 0);
  assert.equal(r.clvPercent, 0);
});
test("even money: -100 vs +100 → zero CLV (same price)", () => {
  const r = computeClv(-100, 100);
  assert.equal(r.clvPoints, 0);
  assert.equal(r.clvPercent, 0);
});
test("CLV is rounded to 2 decimal places", () => {
  const r = computeClv(-110, -120);
  assert.equal(Math.round(r.clvPoints * 100) / 100, r.clvPoints);
  assert.equal(Math.round(r.clvPercent * 100) / 100, r.clvPercent);
});

// ── lock labels ─────────────────────────────────────────────────────
test("lock label: mlb → first pitch", () => {
  assert.equal(lockLabelForSport("mlb"), "Lock at first pitch");
});
test("lock label: nba → tip", () => {
  assert.equal(lockLabelForSport("nba"), "Lock at tip");
});
test("lock label: nhl → puck drop", () => {
  assert.equal(lockLabelForSport("nhl"), "Lock at puck drop");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
