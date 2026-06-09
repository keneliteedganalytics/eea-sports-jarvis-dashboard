// Tier ladder (v5 collapsed) — verifies the four-tier thresholds, the trap-cap
// downgrade, the explicit downgrade step, and the conviction unit mapping.
// Run: tsx server/__tests__/tier.test.ts

import assert from "node:assert/strict";
import { assignTier, downgradeTier } from "../core/tier";
import { convictionUnits } from "../core/sizing";

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

console.log("tier ladder — v5 collapse (SNIPER/EDGE/RECON/PASS)");

test("SNIPER: edge ≥7pp AND conf ≥65", () => {
  assert.equal(assignTier({ edgePp: 7.0, confidence: 65 }), "SNIPER");
  assert.equal(assignTier({ edgePp: 12, confidence: 90 }), "SNIPER");
});

test("EDGE: edge ≥5pp AND conf ≥55 (but not SNIPER)", () => {
  assert.equal(assignTier({ edgePp: 5.0, confidence: 55 }), "EDGE");
  assert.equal(assignTier({ edgePp: 7.0, confidence: 60 }), "EDGE"); // conf short of SNIPER
});

test("RECON: edge ≥3pp AND conf ≥50 (but not EDGE)", () => {
  assert.equal(assignTier({ edgePp: 3.0, confidence: 50 }), "RECON");
  assert.equal(assignTier({ edgePp: 5.0, confidence: 52 }), "RECON"); // conf short of EDGE
});

test("PASS: below RECON floor on either axis", () => {
  assert.equal(assignTier({ edgePp: 2.9, confidence: 99 }), "PASS"); // edge too low
  assert.equal(assignTier({ edgePp: 9.0, confidence: 49 }), "PASS"); // conf too low
  assert.equal(assignTier({ edgePp: null, confidence: 80 }), "PASS");
});

test("hardPass forces PASS regardless of edge/conf", () => {
  assert.equal(assignTier({ edgePp: 12, confidence: 95, hardPass: true }), "PASS");
});

test("trapCapped downgrades one rung", () => {
  assert.equal(assignTier({ edgePp: 12, confidence: 90, trapCapped: true }), "EDGE");
  assert.equal(assignTier({ edgePp: 5.0, confidence: 60, trapCapped: true }), "RECON");
  assert.equal(assignTier({ edgePp: 3.0, confidence: 50, trapCapped: true }), "PASS");
});

test("downgradeTier steps SNIPER→EDGE→RECON→PASS→PASS", () => {
  assert.equal(downgradeTier("SNIPER"), "EDGE");
  assert.equal(downgradeTier("EDGE"), "RECON");
  assert.equal(downgradeTier("RECON"), "PASS");
  assert.equal(downgradeTier("PASS"), "PASS");
});

test("conviction units: SNIPER 2.5 / EDGE 2.0 / RECON 1.0 / PASS 0", () => {
  assert.equal(convictionUnits("SNIPER"), 2.5);
  assert.equal(convictionUnits("EDGE"), 2.0);
  assert.equal(convictionUnits("RECON"), 1.0);
  assert.equal(convictionUnits("PASS"), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
