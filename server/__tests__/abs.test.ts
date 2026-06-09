// ABS framing exposure (MLB). Verifies the Savant slug builder, the framing
// dependency mapping + clamp, the FIP-penalty math, and the neutral fallback
// when a pitcher can't be identified. Network paths are not exercised — the
// fetch is best-effort and folds failures into NEUTRAL_ABS.
// Run: tsx server/__tests__/abs.test.ts

import assert from "node:assert/strict";
import {
  savantSlug,
  framingDependencyFromSignal,
  absFipPenalty,
  absAdjustmentForPitcher,
  NEUTRAL_ABS,
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

console.log("ABS framing exposure — slug, dependency, penalty, fallback");

test("savantSlug builds firstname-lastname-id (accents stripped)", () => {
  assert.equal(savantSlug("Chris Sale", 519242), "chris-sale-519242");
  assert.equal(savantSlug("José Berríos", 621244), "jose-berrios-621244");
});

test("savantSlug returns null without a name or id", () => {
  assert.equal(savantSlug(null, 123), null);
  assert.equal(savantSlug("Chris Sale", null), null);
  assert.equal(savantSlug("Chris Sale", undefined), null);
});

test("framingDependency maps positive called-strike edge into [0,1]", () => {
  assert.equal(framingDependencyFromSignal(0), 0);
  assert.equal(framingDependencyFromSignal(3), 0.5);
  assert.equal(framingDependencyFromSignal(6), 1);
});

test("framingDependency clamps out-of-range / negative / null", () => {
  assert.equal(framingDependencyFromSignal(12), 1);
  assert.equal(framingDependencyFromSignal(-4), 0);
  assert.equal(framingDependencyFromSignal(null), 0);
});

test("absFipPenalty = weight × dependency (clamped)", () => {
  assert.equal(absFipPenalty(1), FRAMING_FIP_WEIGHT);
  assert.equal(absFipPenalty(0.5), Math.round(FRAMING_FIP_WEIGHT * 0.5 * 100) / 100);
  assert.equal(absFipPenalty(0), 0);
  assert.equal(absFipPenalty(2), FRAMING_FIP_WEIGHT); // clamped to 1
});

test("NEUTRAL_ABS is a zeroed, not-found adjustment", () => {
  assert.equal(NEUTRAL_ABS.found, false);
  assert.equal(NEUTRAL_ABS.framingDependency, 0);
  assert.equal(NEUTRAL_ABS.fipPenalty, 0);
});

await testAsync("absAdjustmentForPitcher degrades to neutral without an id", async () => {
  const a = await absAdjustmentForPitcher("Chris Sale", null);
  assert.equal(a.found, false);
  assert.equal(a.fipPenalty, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
