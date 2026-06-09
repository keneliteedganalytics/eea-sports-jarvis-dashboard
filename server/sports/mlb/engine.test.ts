// Unit tests for the locked betting math. Run with: npm test
// Standalone tsx harness (no jest/vitest) using node:assert.
import assert from "node:assert/strict";
import { americanToProb } from "../../core/odds";
import { assignTier } from "../../core/tier";
import { kellyFraction, computeKellyStake, KELLY_CAP_PCT } from "../../core/kelly";

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

console.log("betting math");

test("americanToProb(-150) ≈ 0.60", () => {
  const p = americanToProb(-150);
  assert.notEqual(p, null);
  assert.ok(Math.abs((p as number) - 0.6) < 0.001, `got ${p}`);
});

test("assignTier(edge=8.5, conf=82) → SNIPER", () => {
  const tier = assignTier({ edgePp: 8.5, confidence: 82 });
  assert.equal(tier, "SNIPER");
});

test("assignTier(edge=5.5, conf=60) → EDGE", () => {
  assert.equal(assignTier({ edgePp: 5.5, confidence: 60 }), "EDGE");
});

test("assignTier(edge=3.5, conf=52) → RECON", () => {
  assert.equal(assignTier({ edgePp: 3.5, confidence: 52 }), "RECON");
});

test("assignTier(edge=2.0, conf=80) → PASS (below RECON edge floor)", () => {
  assert.equal(assignTier({ edgePp: 2.0, confidence: 80 }), "PASS");
});

test("kellyFraction(0.55, -110) > 0", () => {
  const f = kellyFraction(0.55, -110);
  assert.ok(f > 0, `expected positive, got ${f}`);
});

test("quarter-Kelly cap respected (≤ 3% bankroll)", () => {
  // A monster edge would blow past the cap at full Kelly; quarter-Kelly + cap clamps it.
  const r = computeKellyStake(0.95, -110, 10000);
  assert.ok(r.finalFraction <= KELLY_CAP_PCT + 1e-9, `fraction ${r.finalFraction} exceeds cap ${KELLY_CAP_PCT}`);
  assert.ok(r.capped, "expected capped flag to be set on an oversized edge");
  assert.ok(r.stakeDollars <= 10000 * KELLY_CAP_PCT + 0.01, `stake ${r.stakeDollars} exceeds 3% of bankroll`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
