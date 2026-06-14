// Pillar 3 (v6.9.0) — score-distribution Monte Carlo. Proves: a 4.8-vs-4.0
// matchup yields P(A wins) near 58% with a median margin near +0.8, the mean run
// totals recover the inputs, P(over) tracks the total line, a pick'em (equal
// lambdas) is ~50/50, and the same seed is reproducible. Pure (seeded RNG) — no
// network. Run: tsx server/__tests__/runDistribution.test.ts

import assert from "node:assert/strict";
import { simulateRunDistribution } from "../sim/runDistribution";

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

console.log("Pillar 3 — run-distribution Monte Carlo (v6.9.0)");

// Use a large iteration count for stable assertions.
const r = simulateRunDistribution({
  projRunsA: 4.8, projRunsB: 4.0, iterations: 20000, seed: 12345, overUnderLine: 8.5,
});

test("P(A wins) for 4.8 vs 4.0 lands near 58% (±4)", () => {
  assert.ok(Math.abs(r.pAWins - 0.58) < 0.04, `got pAWins=${r.pAWins}`);
});

test("median margin is near +0.8 (within 1 run grid)", () => {
  assert.ok(r.medianMargin >= 0 && r.medianMargin <= 2, `got median margin=${r.medianMargin}`);
});

test("mean run totals recover the inputs (±0.15)", () => {
  assert.ok(Math.abs(r.projScoreA - 4.8) < 0.15, `got projScoreA=${r.projScoreA}`);
  assert.ok(Math.abs(r.projScoreB - 4.0) < 0.15, `got projScoreB=${r.projScoreB}`);
});

test("pAWins + pBWins = 1 (ties split)", () => {
  assert.ok(Math.abs(r.pAWins + r.pBWins - 1) < 1e-9, `sum=${r.pAWins + r.pBWins}`);
});

test("P(over 8.5) is reported and in (0,1)", () => {
  assert.ok(r.pOver !== null && r.pOver > 0 && r.pOver < 1, `got pOver=${r.pOver}`);
});

test("no line → pOver is null", () => {
  const x = simulateRunDistribution({ projRunsA: 4.5, projRunsB: 4.5, iterations: 1000, seed: 1 });
  assert.equal(x.pOver, null);
});

test("pick'em (equal lambdas) is ~50/50 (±4)", () => {
  const x = simulateRunDistribution({ projRunsA: 4.4, projRunsB: 4.4, iterations: 20000, seed: 7 });
  assert.ok(Math.abs(x.pAWins - 0.5) < 0.04, `got pAWins=${x.pAWins}`);
});

test("same seed is reproducible", () => {
  const a = simulateRunDistribution({ projRunsA: 5, projRunsB: 4, iterations: 5000, seed: 42 });
  const b = simulateRunDistribution({ projRunsA: 5, projRunsB: 4, iterations: 5000, seed: 42 });
  assert.equal(a.pAWins, b.pAWins);
  assert.equal(a.projScoreA, b.projScoreA);
});

test("A covers -1.5 less often than A wins outright", () => {
  assert.ok(r.pACoversMinus1_5 < r.pAWins, `cover=${r.pACoversMinus1_5} win=${r.pAWins}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
