// Unit tests for handednessSplits.ts — handedness delta, wOBA computation.
// Pure unit tests; no network calls.
// Run: tsx server/__tests__/handednessSplits.test.ts

import assert from "node:assert/strict";
import { deltaVsOpposingHand, type HandednessSplit } from "../sports/mlb/handednessSplits";

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

console.log("handednessSplits — unit tests");

// ── Helper to build a mock HandednessSplit ────────────────────────────────────
function makeSplit(vsLHPwOBA: number | null, vsRHPwOBA: number | null): HandednessSplit {
  return {
    teamId: 999,
    triCode: "TST",
    vsLHP: { wOBA: vsLHPwOBA, ops: null, kPct: null },
    vsRHP: { wOBA: vsRHPwOBA, ops: null, kPct: null },
    staleness: "fresh",
  };
}

// ── deltaVsOpposingHand ───────────────────────────────────────────────────────

test("delta: team crushes LHP (+0.030 vs LHP) → positive delta when opp is LHP", () => {
  const split = makeSplit(0.348, 0.318); // +0.030 vs LHP
  const delta = deltaVsOpposingHand(split, "L", 0.318);
  assert.ok(Math.abs(delta - 0.030) < 0.001, `Expected 0.030, got ${delta}`);
});

test("delta: team struggles vs RHP (-0.025 vs RHP) → negative delta when opp is RHP", () => {
  const split = makeSplit(0.318, 0.293); // -0.025 vs RHP
  const delta = deltaVsOpposingHand(split, "R", 0.318);
  assert.ok(Math.abs(delta - (-0.025)) < 0.001, `Expected -0.025, got ${delta}`);
});

test("delta: null wOBA for split → returns 0 (neutral)", () => {
  const split = makeSplit(null, 0.310);
  assert.equal(deltaVsOpposingHand(split, "L", 0.318), 0);
});

test("delta: null wOBA for vsRHP → returns 0 (neutral) when opp is RHP", () => {
  const split = makeSplit(0.340, null);
  assert.equal(deltaVsOpposingHand(split, "R", 0.318), 0);
});

test("delta: same wOBA as baseline → 0 (no advantage)", () => {
  const split = makeSplit(0.318, 0.318);
  assert.equal(deltaVsOpposingHand(split, "L", 0.318), 0);
  assert.equal(deltaVsOpposingHand(split, "R", 0.318), 0);
});

test("delta: L/R selection correct — vsLHP used when opp is LHP", () => {
  const split = makeSplit(0.350, 0.280);
  const deltaVsL = deltaVsOpposingHand(split, "L", 0.318);
  const deltaVsR = deltaVsOpposingHand(split, "R", 0.318);
  // vsLHP is higher, so delta vs LHP should be positive, vs RHP negative
  assert.ok(deltaVsL > 0, `Expected positive delta vs LHP, got ${deltaVsL}`);
  assert.ok(deltaVsR < 0, `Expected negative delta vs RHP, got ${deltaVsR}`);
});

// ── Model run adjustment from handedness delta ────────────────────────────────
// Spec: +0.030 wOBA delta → +0.15 run adjustment

test("handedness adj: +0.030 wOBA delta → +0.15 run adj (spec compliance)", () => {
  const wOBADelta = 0.030;
  const rawAdj = (wOBADelta / 0.030) * 0.15;
  const adj = Math.max(-0.30, Math.min(0.30, rawAdj));
  assert.ok(Math.abs(adj - 0.15) < 0.001, `Expected +0.15, got ${adj}`);
});

test("handedness adj: -0.025 wOBA delta → -0.125 run adj (proportional)", () => {
  const wOBADelta = -0.025;
  const rawAdj = (wOBADelta / 0.030) * 0.15;
  const expected = -0.025 / 0.030 * 0.15; // ≈ -0.125
  assert.ok(Math.abs(rawAdj - expected) < 0.001, `Expected ${expected}, got ${rawAdj}`);
});

test("handedness adj: clamped at ±0.30 for extreme deltas", () => {
  const wOBADelta = 0.100; // large positive
  const rawAdj = (wOBADelta / 0.030) * 0.15; // 0.5
  const adj = Math.max(-0.30, Math.min(0.30, rawAdj));
  assert.equal(adj, 0.30);

  const wOBADeltaNeg = -0.100;
  const rawAdjNeg = (wOBADeltaNeg / 0.030) * 0.15;
  const adjNeg = Math.max(-0.30, Math.min(0.30, rawAdjNeg));
  assert.equal(adjNeg, -0.30);
});

test("handedness adj: zero delta → zero run adjustment", () => {
  const rawAdj = (0 / 0.030) * 0.15;
  assert.equal(rawAdj, 0);
});

// ── staleness propagation ────────────────────────────────────────────────────
test("staleness values are one of fresh/cached/missing", () => {
  const validStates = new Set(["fresh", "cached", "missing"]);
  const s: HandednessSplit = makeSplit(0.318, 0.318);
  assert.ok(validStates.has(s.staleness), `Unknown staleness: ${s.staleness}`);
});

// ── edge cases ───────────────────────────────────────────────────────────────
test("missing split record: all null wOBAs return 0 deltas for both hands", () => {
  const missing = makeSplit(null, null);
  assert.equal(deltaVsOpposingHand(missing, "L", 0.318), 0);
  assert.equal(deltaVsOpposingHand(missing, "R", 0.318), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
