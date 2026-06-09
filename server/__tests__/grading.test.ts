// Grading rules: moneyline / spread / total W-L-P and the P/L-in-units math at
// American odds. Pure functions — no DB, no network.
// Run: tsx server/__tests__/grading.test.ts

import assert from "node:assert/strict";
import { gradeMoneyline, gradeSpread, gradeTotal, plUnits } from "../grading";

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

console.log("grading rules + P/L");

// ── moneyline ───────────────────────────────────────────────────────
test("ML: away pick wins when away outscores home", () => {
  assert.equal(gradeMoneyline("away", 5, 3), "W");
});
test("ML: away pick loses when home outscores away", () => {
  assert.equal(gradeMoneyline("away", 3, 5), "L");
});
test("ML: home pick wins when home outscores away", () => {
  assert.equal(gradeMoneyline("home", 3, 5), "W");
});
test("ML: equal final is a push", () => {
  assert.equal(gradeMoneyline("home", 2, 2), "P");
});

// ── acceptance: SAS @ NYK, NYK ML -125, final SA 115 / NY 111 → LOSS ─
test("ML acceptance: NYK home ML grades LOSS at SA 115 / NY 111", () => {
  // away = SAS (115), home = NYK (111); pick side = home (NYK)
  assert.equal(gradeMoneyline("home", 115, 111), "L");
});

// ── P/L in units ────────────────────────────────────────────────────
test("P/L: +110 1u win → +1.10", () => {
  assert.equal(plUnits("W", 1, 110), 1.1);
});
test("P/L: -125 2u win → +1.60", () => {
  assert.equal(plUnits("W", 2, -125), 1.6);
});
test("P/L: -110 1.5u loss → -1.5", () => {
  assert.equal(plUnits("L", 1.5, -110), -1.5);
});
test("P/L: push → 0 regardless of odds/units", () => {
  assert.equal(plUnits("P", 2.5, -180), 0);
});
test("P/L: null ml win pays even money", () => {
  assert.equal(plUnits("W", 1, null), 1);
});

// ── spread ──────────────────────────────────────────────────────────
test("spread: away -1.5 covers when winning by 2", () => {
  // away 5, home 3 → away -1.5 → 3.5 vs 3 → W
  assert.equal(gradeSpread("away", -1.5, 5, 3), "W");
});
test("spread: home -1.5 does not cover a 1-run win", () => {
  // away 3, home 4 → home -1.5 → 2.5 vs 3 → L
  assert.equal(gradeSpread("home", -1.5, 3, 4), "L");
});
test("spread: exact landing is a push", () => {
  // away 3, home 5 → away +2 → 5 vs 5 → P
  assert.equal(gradeSpread("away", 2, 3, 5), "P");
});

// ── total ───────────────────────────────────────────────────────────
test("total: over wins above the line", () => {
  assert.equal(gradeTotal("over", 7.5, 5, 4), "W");
});
test("total: under wins below the line", () => {
  assert.equal(gradeTotal("under", 7.5, 3, 4), "W");
});
test("total: exact landing is a push", () => {
  assert.equal(gradeTotal("over", 8, 5, 3), "P");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
