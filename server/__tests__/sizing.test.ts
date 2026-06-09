// EEA flat-unit sizing tests. Pins the $25,000 bankroll → $375 unit math, the
// conviction-tier unit ladder, the -180 juice half-cut, and the 18% slate
// exposure cap. Run: tsx server/__tests__/sizing.test.ts

import assert from "node:assert/strict";

import {
  FLAT_UNIT_PCT,
  computeUnit,
  convictionUnits,
  applyJuicePenalty,
  unitsToStake,
  applyExposureCap,
  EXPOSURE_CAP_PCT,
} from "../core/sizing";
import { BANKROLL_USD } from "../sports/mlb/picksEngine";

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

console.log("sizing (bankroll → units → stake)");

const BANK = 25000;

test("bankroll default is $25,000", () => {
  assert.equal(BANKROLL_USD, 25000, "repo default bankroll should be 25k");
});

test("flat unit is 1.5% of bankroll = $375 at $25k", () => {
  assert.equal(FLAT_UNIT_PCT, 0.015);
  assert.equal(computeUnit(BANK), 375);
});

test("conviction unit ladder maps to exact counts", () => {
  assert.equal(convictionUnits("SNIPER"), 2.5);
  assert.equal(convictionUnits("EDGE"), 2.0);
  assert.equal(convictionUnits("RECON"), 1.0);
  assert.equal(convictionUnits("PASS"), 0);
});

test("dollar stakes per tier at $25k bankroll", () => {
  assert.equal(unitsToStake(convictionUnits("SNIPER"), BANK), 938); // 2.5u → 937.5 → 938
  assert.equal(unitsToStake(convictionUnits("EDGE"), BANK), 750); // 2.0u
  assert.equal(unitsToStake(convictionUnits("RECON"), BANK), 375); // 1.0u
});

test("juice penalty halves units beyond -180", () => {
  assert.deepEqual(applyJuicePenalty(2.0, -200), { units: 1.0, halfCut: true });
  assert.deepEqual(applyJuicePenalty(2.0, -180), { units: 2.0, halfCut: false }); // exactly -180 not cut
  assert.deepEqual(applyJuicePenalty(2.0, -110), { units: 2.0, halfCut: false });
  assert.deepEqual(applyJuicePenalty(2.0, 120), { units: 2.0, halfCut: false });
  assert.deepEqual(applyJuicePenalty(2.0, null), { units: 2.0, halfCut: false });
});

test("exposure cap leaves a small board untouched", () => {
  const stakes = [
    { units: 3, stakeDollars: 1125 },
    { units: 1, stakeDollars: 375 },
  ];
  const out = applyExposureCap(stakes, BANK);
  assert.ok(out.every((s) => !s.trimmed), "under 18% cap, nothing trimmed");
  assert.equal(out[0].stakeDollars, 1125);
});

test("exposure cap scales down an over-exposed board", () => {
  // cap = 18% of 25k = 4500. Six 3u plays = 6 * 1125 = 6750 > 4500.
  const stakes = Array.from({ length: 6 }, () => ({ units: 3, stakeDollars: 1125 }));
  const out = applyExposureCap(stakes, BANK);
  assert.ok(out.every((s) => s.trimmed), "all plays trimmed");
  const total = out.reduce((s, x) => s + x.stakeDollars, 0);
  const cap = BANK * EXPOSURE_CAP_PCT;
  assert.ok(total <= cap + 6, `trimmed total ${total} should sit at/under cap ${cap}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
