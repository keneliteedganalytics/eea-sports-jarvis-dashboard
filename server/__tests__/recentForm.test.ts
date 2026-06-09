// Recent-form splits (MLB). Verifies the OPS+ proxy, the season/last-14 RPG
// blend, the last-7 confidence delta (hot/cold/neutral), and the NEUTRAL
// fallback. Network paths are not exercised — recentFormForTeam is best-effort
// and folds failures into NEUTRAL_FORM.
// Run: tsx server/__tests__/recentForm.test.ts

import assert from "node:assert/strict";
import {
  opsPlus,
  blendedRpg,
  recentFormConfidenceDelta,
  recentFormForTeam,
  NEUTRAL_FORM,
  L14_BLEND_WEIGHT,
  SEASON_BLEND_WEIGHT,
  HOT_WRC_PLUS,
  COLD_WRC_PLUS,
} from "../sports/mlb/recentForm";

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

console.log("Recent form — OPS+ proxy, RPG blend, confidence delta, fallback");

test("opsPlus: league-average OPS reads ~100, null on missing/zero", () => {
  assert.equal(opsPlus(0.73), 100);
  assert.equal(opsPlus(0.876), 120); // 0.876/0.73 = 1.2 → 120
  assert.equal(opsPlus(null), null);
  assert.equal(opsPlus(0), null);
});

test("blendedRpg = 70% season + 30% last-14", () => {
  assert.equal(SEASON_BLEND_WEIGHT, 0.7);
  assert.equal(L14_BLEND_WEIGHT, 0.3);
  // 0.7*4.0 + 0.3*6.0 = 2.8 + 1.8 = 4.6
  assert.equal(blendedRpg(4.0, 6.0), 4.6);
});

test("blendedRpg degrades to whichever value is present", () => {
  assert.equal(blendedRpg(4.5, null), 4.5);
  assert.equal(blendedRpg(null, 5.0), 5.0);
  assert.equal(blendedRpg(null, null), null);
});

test("confidence delta: hot last-7 +2, cold −2, neutral 0", () => {
  assert.equal(recentFormConfidenceDelta({ found: true, l7OpsPlus: HOT_WRC_PLUS + 1, l14Rpg: null }), 2);
  assert.equal(recentFormConfidenceDelta({ found: true, l7OpsPlus: COLD_WRC_PLUS - 1, l14Rpg: null }), -2);
  assert.equal(recentFormConfidenceDelta({ found: true, l7OpsPlus: 100, l14Rpg: null }), 0);
});

test("confidence delta is 0 at the exact thresholds (strict inequalities)", () => {
  assert.equal(recentFormConfidenceDelta({ found: true, l7OpsPlus: HOT_WRC_PLUS, l14Rpg: null }), 0);
  assert.equal(recentFormConfidenceDelta({ found: true, l7OpsPlus: COLD_WRC_PLUS, l14Rpg: null }), 0);
});

test("NEUTRAL_FORM is a no-op for the confidence delta", () => {
  assert.equal(NEUTRAL_FORM.found, false);
  assert.equal(recentFormConfidenceDelta(NEUTRAL_FORM), 0);
});

await testAsync("recentFormForTeam degrades to neutral without a team id", async () => {
  const f = await recentFormForTeam(null);
  assert.equal(f.found, false);
  assert.equal(recentFormConfidenceDelta(f), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
