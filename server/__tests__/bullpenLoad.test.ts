// Pillar 5 (v6.9.0) — bullpen fatigue. Proves the pure core: fatigue normalizes
// 3-day relief pitches to 0..1 (350 → 1.0, capped), the dampened late-inning run
// bump is +0.075 at full fatigue, relief pitches are estimated from game-log outs
// within a 3-day window (older games ignored), and a fatigued pen bumps the
// OPPOSING side's runs in the run-distribution sim. Pure — no network. Run: tsx
// server/__tests__/bullpenLoad.test.ts

import assert from "node:assert/strict";
import {
  bullpenFatiguePct,
  bullpenFatigueRunBump,
  estimateReliefPitches,
} from "../sources/bullpenLoad";
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

console.log("Pillar 5 — bullpen fatigue (v6.9.0)");

test("fatiguePct: 175 pitches → 0.5", () => {
  assert.ok(Math.abs(bullpenFatiguePct(175) - 0.5) < 1e-9, `got ${bullpenFatiguePct(175)}`);
});

test("fatiguePct caps at 1.0 (500 → 1.0)", () => {
  assert.equal(bullpenFatiguePct(500), 1);
});

test("run bump at full fatigue is 0.075", () => {
  assert.ok(Math.abs(bullpenFatigueRunBump(1) - 0.075) < 1e-9, `got ${bullpenFatigueRunBump(1)}`);
});

test("run bump scales with fatigue", () => {
  assert.ok(bullpenFatigueRunBump(0.5) < bullpenFatigueRunBump(1));
  assert.equal(bullpenFatigueRunBump(0), 0);
});

test("estimateReliefPitches counts only games within 3 days", () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = "2020-01-01";
  const splits = [
    { date: today, stat: { inningsPitched: "9.0" } }, // 27 outs, ~11 relief outs
    { date: old, stat: { inningsPitched: "9.0" } }, // ignored (too old)
  ];
  const p = estimateReliefPitches(splits);
  // relief outs = 27-16 = 11 → (11/3)*16 ≈ 59 pitches, only from the recent game.
  assert.ok(p > 40 && p < 80, `got ${p}`);
});

test("estimateReliefPitches floors relief outs at 0 (short starts excluded)", () => {
  const today = new Date().toISOString().slice(0, 10);
  const splits = [{ date: today, stat: { inningsPitched: "5.0" } }]; // 15 outs < 16 → 0 relief
  assert.equal(estimateReliefPitches(splits), 0);
});

test("a fatigued pen bumps the OPPOSING side's runs in the sim", () => {
  const base = simulateRunDistribution({ projRunsA: 4.5, projRunsB: 4.5, iterations: 30000, seed: 5 });
  // Side A's pen is gassed → side B should score more, lowering A's win prob.
  const tired = simulateRunDistribution({
    projRunsA: 4.5, projRunsB: 4.5, iterations: 30000, seed: 5, fatigueA: 1,
  });
  assert.ok(tired.projScoreB > base.projScoreB, `B runs base=${base.projScoreB} tired=${tired.projScoreB}`);
  assert.ok(tired.pAWins < base.pAWins, `A win base=${base.pAWins} tired=${tired.pAWins}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
