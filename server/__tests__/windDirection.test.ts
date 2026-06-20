// Fix 1: windDirectionRunAdjust — real bearing-based computation.
// Fix 5: parkFactorForBatterHand — L/R split table.
// Run: tsx server/__tests__/windDirection.test.ts

import assert from "node:assert/strict";
import {
  windDirectionRunAdjust,
  PARK_ORIENTATIONS,
  parkFactorForBatterHand,
  parkFactorForTeam,
  PARK_FACTORS,
  PARK_FACTORS_HANDED,
} from "../sports/mlb/weather";

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

console.log("Fix 1 — windDirectionRunAdjust");

test("backward compat: pre-computed windRunAdj wins over bearing calculation", () => {
  const result = windDirectionRunAdjust("CHC", { windRunAdj: 0.25 });
  assert.ok(result, "result should not be null");
  assert.equal(result!.runAdj, 0.25);
});

test("pre-computed windRunAdj is clamped to ±0.5", () => {
  const r = windDirectionRunAdjust("CHC", { windRunAdj: 1.5 });
  assert.ok(r);
  assert.equal(r!.runAdj, 0.5);
  const r2 = windDirectionRunAdjust("CHC", { windRunAdj: -1.5 });
  assert.ok(r2);
  assert.equal(r2!.runAdj, -0.5);
});

test("null weatherRaw returns null", () => {
  assert.equal(windDirectionRunAdjust("CHC", null), null);
});

test("tailwind directly to CF → positive run adjustment", () => {
  // Wrigley CF bearing ≈ 30°. Wind blowing TO 30° (exactly out to CF).
  const r = windDirectionRunAdjust("CHC", { windBearingDeg: 30, windMph: 10 });
  assert.ok(r);
  // cos(0) = 1, so adj = 1 * 10 * 0.04 = 0.40
  assert.ok(r!.runAdj > 0, `expected positive adj, got ${r!.runAdj}`);
  assert.ok(Math.abs(r!.runAdj - 0.40) < 0.001, `expected ~0.40, got ${r!.runAdj}`);
});

test("headwind directly from CF → negative run adjustment", () => {
  // Wind blowing TO 210° (= 30° + 180°) = directly from CF at Wrigley.
  const r = windDirectionRunAdjust("CHC", { windBearingDeg: 210, windMph: 10 });
  assert.ok(r);
  assert.ok(r!.runAdj < 0, `expected negative adj, got ${r!.runAdj}`);
  assert.ok(Math.abs(r!.runAdj + 0.40) < 0.001, `expected ~-0.40, got ${r!.runAdj}`);
});

test("crosswind (90° off CF axis) → ~zero run adjustment", () => {
  // Wrigley CF = 30°. Crosswind blowing to 120° (90° off CF).
  const r = windDirectionRunAdjust("CHC", { windBearingDeg: 120, windMph: 20 });
  assert.ok(r);
  // cos(90°) = 0, so adj ≈ 0
  assert.ok(Math.abs(r!.runAdj) < 0.01, `expected ~0 crosswind adj, got ${r!.runAdj}`);
});

test("adjustment is clamped to ±0.40 for strong tailwinds", () => {
  // 100 mph tailwind — unrealistic but tests the cap
  const r = windDirectionRunAdjust("COL", { windBearingDeg: 0, windMph: 100 });
  assert.ok(r);
  assert.equal(r!.runAdj, 0.40);
});

test("missing bearing → returns runAdj 0 (neutral)", () => {
  const r = windDirectionRunAdjust("NYY", { windMph: 12 });
  assert.ok(r);
  assert.equal(r!.runAdj, 0.0);
});

test("missing windMph → returns runAdj 0 (neutral)", () => {
  const r = windDirectionRunAdjust("NYY", { windBearingDeg: 0 });
  assert.ok(r);
  assert.equal(r!.runAdj, 0.0);
});

test("unknown park defaults to bearing 0 (conservative fallback)", () => {
  // 'XYZ' not in table; uses bearing 0.
  const r1 = windDirectionRunAdjust("XYZ", { windBearingDeg: 0, windMph: 10 });
  const r2 = windDirectionRunAdjust("COL", { windBearingDeg: 0, windMph: 10 });
  assert.ok(r1 && r2);
  // Both use bearing 0, so adjustments should be equal
  assert.equal(r1!.runAdj, r2!.runAdj);
});

test("all 30 park tri-codes have an orientation entry", () => {
  for (const triCode of Object.keys(PARK_FACTORS)) {
    assert.ok(
      PARK_ORIENTATIONS[triCode] !== undefined,
      `missing PARK_ORIENTATIONS entry for ${triCode}`,
    );
  }
});

console.log("\nFix 5 — parkFactorForBatterHand + PARK_FACTORS_HANDED");

test("Yankee Stadium: LHB factor > RHB factor", () => {
  const L = parkFactorForBatterHand("NYY", "L");
  const R = parkFactorForBatterHand("NYY", "R");
  assert.ok(L > R, `expected NYY L (${L}) > R (${R})`);
});

test("Fenway: RHB factor > LHB factor (Green Monster)", () => {
  const L = parkFactorForBatterHand("BOS", "L");
  const R = parkFactorForBatterHand("BOS", "R");
  assert.ok(R > L, `expected BOS R (${R}) > L (${L})`);
});

test("parkFactorForTeam scalar is unchanged by new L/R table", () => {
  // The scalar function should still return the same values as before.
  for (const [code, factor] of Object.entries(PARK_FACTORS)) {
    const scalar = parkFactorForTeam(code);
    assert.equal(scalar, factor, `parkFactorForTeam(${code}) changed`);
  }
});

test("parkFactorForBatterHand with null hand falls back to scalar", () => {
  const scalar = parkFactorForTeam("NYY");
  const fallback = parkFactorForBatterHand("NYY", null);
  assert.equal(fallback, scalar, `expected null-hand to match scalar for NYY`);
});

test("parkFactorForBatterHand with unknown park falls back to scalar", () => {
  const fallback = parkFactorForBatterHand("ZZZ", "L");
  assert.equal(fallback, 1.0);
});

test("all 30 parks have an entry in PARK_FACTORS_HANDED", () => {
  for (const triCode of Object.keys(PARK_FACTORS)) {
    assert.ok(
      PARK_FACTORS_HANDED[triCode] !== undefined,
      `missing PARK_FACTORS_HANDED entry for ${triCode}`,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
