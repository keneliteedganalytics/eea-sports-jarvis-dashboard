// SNIPER chalk cap env override (v6.8.1). Setting SNIPER_MAX_CHALK_AMERICAN
// before module load dials the cap without a redeploy. With cap=-200, a -210
// candidate (chalkier than -200) demotes out of SNIPER on BOTH surfaces, while a
// -190 candidate still clears it. The env must be set BEFORE the dynamic import
// because the constant is read at module-eval time. Run: tsx
// server/__tests__/sniperChalkGate_envOverride.test.ts

import assert from "node:assert/strict";

process.env.SNIPER_MAX_CHALK_AMERICAN = "-200";

const { assignTier, SNIPER_MAX_CHALK_AMERICAN } = await import("../core/tier");
const { assignPropTier } = await import("../sports/props/buildPropPicks");
type HR = import("../sports/props/hitRates").HitRates;

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

console.log("SNIPER chalk cap env override — v6.8.1 (cap=-200)");

const GAME_SNIPER = { edgePp: 8, confidence: 80, winProb: 0.55, dataQualityTier: "HIGH", evPer100: 10 } as const;
const overWindow: HR["l20"] = { decided: 20, over: 14, rate: 0.7 };
const PROP_SNIPER = { edgePp: 8, side: "over" as const, l10: overWindow, l20: overWindow as HR["l10"], dataQualityTier: "HIGH" };

test("the override is honored: cap reads as -200", () => {
  assert.equal(SNIPER_MAX_CHALK_AMERICAN, -200);
});

test("game: -210 demotes out of SNIPER under the -200 cap", () => {
  assert.notEqual(assignTier({ ...GAME_SNIPER, oddsAmerican: -210 }), "SNIPER");
});

test("game: -190 still SNIPER under the -200 cap", () => {
  assert.equal(assignTier({ ...GAME_SNIPER, oddsAmerican: -190 }), "SNIPER");
});

test("prop: -210 demotes out of SNIPER under the -200 cap", () => {
  assert.notEqual(assignPropTier({ ...PROP_SNIPER, american: -210 }), "SNIPER");
});

test("prop: -190 still SNIPER under the -200 cap", () => {
  assert.equal(assignPropTier({ ...PROP_SNIPER, american: -190 }), "SNIPER");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
