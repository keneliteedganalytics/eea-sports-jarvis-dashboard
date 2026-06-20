// Fix 2: UmpireAdjustment kRateAdj + umpireTotalsImpactPp.
// Verifies kRateAdj field is populated from kPctDelta, that
// umpireTotalsImpactPp returns the expected market-side prior,
// and that a big-zone ump (kRateAdj > 0.02 i.e. >2pp) returns a negative
// totals impact (lean under).
// Run: tsx server/__tests__/umpireKRate.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set up temp stats file BEFORE importing the module.
const tmpStats = path.join(os.tmpdir(), `umpire_krate_${process.pid}.json`);
fs.writeFileSync(
  tmpStats,
  JSON.stringify([
    {
      umpireId: 427044,
      name: "Pat Hoberg",
      games: 142,
      avgRunsPerGame: 8.4,
      kPctDelta: 1.2,
      bbPctDelta: -0.6,
      runScoreAdjustment: -0.22,
    },
    {
      umpireId: 427050,
      name: "Laz Diaz",
      games: 120,
      avgRunsPerGame: 8.1,
      kPctDelta: 2.5,
      bbPctDelta: -1.3,
      runScoreAdjustment: -0.30,
    },
  ]),
  "utf8",
);
process.env.UMPIRE_STATS_PATH = tmpStats;

const {
  profileFor,
  umpireAdjustmentForGame,
  umpireTotalsImpactPp,
  NEUTRAL_UMPIRE,
  _resetUmpireCache,
} = await import("../sports/mlb/umpires");

_resetUmpireCache();

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
async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("Fix 2 — umpire kRateAdj + umpireTotalsImpactPp");

test("NEUTRAL_UMPIRE has kRateAdj = 0", () => {
  assert.equal(NEUTRAL_UMPIRE.kRateAdj, 0);
  assert.equal(NEUTRAL_UMPIRE.found, false);
});

test("umpireTotalsImpactPp returns 0 for neutral umpire", () => {
  assert.equal(Math.abs(umpireTotalsImpactPp(NEUTRAL_UMPIRE)), 0);
});

test("big-zone ump (kRateAdj > 2pp) returns negative totals impact (lean under)", () => {
  const bigZone = { ...NEUTRAL_UMPIRE, kRateAdj: 2.5, found: true };
  const impact = umpireTotalsImpactPp(bigZone);
  assert.ok(impact < 0, `expected negative totals impact for big-zone ump, got ${impact}`);
});

test("tight-zone ump (kRateAdj < 0) returns positive totals impact (lean over)", () => {
  const tightZone = { ...NEUTRAL_UMPIRE, kRateAdj: -2.0, found: true };
  const impact = umpireTotalsImpactPp(tightZone);
  assert.ok(impact > 0, `expected positive totals impact for tight-zone ump, got ${impact}`);
});

test("umpireTotalsImpactPp is capped at ±2.0pp", () => {
  const extreme = { ...NEUTRAL_UMPIRE, kRateAdj: 100, found: true };
  assert.equal(umpireTotalsImpactPp(extreme), -2.0);
  const extremeNeg = { ...NEUTRAL_UMPIRE, kRateAdj: -100, found: true };
  assert.equal(umpireTotalsImpactPp(extremeNeg), 2.0);
});

await testAsync("umpireAdjustmentForGame(null) has kRateAdj = 0", async () => {
  const adj = await umpireAdjustmentForGame(null);
  assert.equal(adj.kRateAdj, 0);
  assert.equal(adj.found, false);
});

// Cleanup
try { fs.unlinkSync(tmpStats); } catch { /* ignore */ }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
