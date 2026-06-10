// Tests for the calibration probe (v6.7.6). The probe runs one (player, market,
// line, side) through resolve → profile → simulate → edge and returns a debug
// breakdown. We inject deps so no live HTTP is needed: a known average hitter
// must come back available with a realistic expectedPA, hits/PA, and a model
// prob in the calibrated band — and an unresolved player returns available:false
// (no fabricated output). Run: tsx server/__tests__/calibrationProbe.test.ts
import assert from "node:assert/strict";
import { probeSimulator, type ProbeDeps } from "../sports/props/calibrationProbe";
import type { BatterProfile, PitcherProfile } from "../sports/props/mlbStatsProps";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
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

function avgBatter(): BatterProfile {
  return {
    available: true, playerId: 660271, name: "Trea Turner",
    logs: [{ date: "", pa: 80, ab: 80, hits: 22, totalBases: 34, homeRuns: 3, runs: 11, rbi: 10, walks: 6, singles: 16, oppPitcherHand: null, home: true }],
    seasonPa: 600,
    seasonRates: { hitsPerPa: 0.28, tbPerPa: 0.45, hrPerPa: 0.04, runsPerPa: 0.14, rbiPerPa: 0.12, walksPerPa: 0.08, singlesPerPa: 0.19 },
  };
}

const baseDeps: ProbeDeps = {
  resolveId: async (name: string) => (name === "Trea Turner" ? 660271 : null),
  batterProfile: async () => avgBatter(),
  pitcherProfile: async () => ({ available: false } as PitcherProfile),
  schedule: async () => [],
};

console.log("calibration probe");

await test("probe of an average hitter returns realistic expectedPA / hits/PA / modelProb", async () => {
  const r = await probeSimulator("Trea Turner", "batter_hits", 1.5, "over", baseDeps);
  assert.equal(r.available, true, r.reason);
  assert.ok(r.expectedPA! >= 4.0 && r.expectedPA! <= 4.6, `expectedPA ${r.expectedPA} out of [4.0,4.6]`);
  assert.ok(r.hitsPerPA! >= 0.25 && r.hitsPerPA! <= 0.32, `hits/PA ${r.hitsPerPA} out of [0.25,0.32]`);
  assert.ok(r.modelProb! >= 0.28 && r.modelProb! <= 0.45, `modelProb ${r.modelProb} out of [0.28,0.45]`);
});

await test("probe reports the over/under split and a populated distribution", async () => {
  const r = await probeSimulator("Trea Turner", "batter_hits", 1.5, "over", baseDeps);
  assert.ok(r.distribution, "distribution present");
  assert.ok(r.probOver! + r.probUnder! > 0.99, "over+under ≈ 1");
});

await test("probe of an unresolved player returns available:false, no fabricated output", async () => {
  const r = await probeSimulator("Nobody McGhost", "batter_hits", 1.5, "over", baseDeps);
  assert.equal(r.available, false);
  assert.equal(r.modelProb ?? null, null);
  assert.ok(r.reason && r.reason.length > 0);
});

await test("probe rejects an unknown market shape gracefully", async () => {
  const r = await probeSimulator("Trea Turner", "batter_nonsense" as never, 1.5, "over", baseDeps);
  assert.equal(r.available, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
