// Tier ladder (v6.6 sharp calibration) — verifies the four-tier thresholds with
// the new AND-gates (win-prob floor, data quality, EV ceiling), the trap-cap
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

console.log("tier ladder — v6.6 (SNIPER/EDGE/RECON/PASS, AND-gated)");

// Healthy gating inputs reused across the happy-path cases.
const HQ = { winProb: 0.55, dataQualityTier: "HIGH", evPer100: 10 } as const;

test("SNIPER: edge ≥6pp AND conf ≥70 AND wp≥.30 AND ev≤25 AND HIGH data", () => {
  assert.equal(assignTier({ edgePp: 6.0, confidence: 70, ...HQ }), "SNIPER");
  assert.equal(assignTier({ edgePp: 12, confidence: 90, ...HQ }), "SNIPER");
});

test("EDGE: edge ≥4pp AND conf ≥60 AND wp≥.25 AND HIGH/MED (but not SNIPER)", () => {
  assert.equal(assignTier({ edgePp: 4.0, confidence: 60, ...HQ }), "EDGE");
  assert.equal(assignTier({ edgePp: 6.0, confidence: 65, ...HQ }), "EDGE"); // conf short of SNIPER
  assert.equal(
    assignTier({ edgePp: 6.0, confidence: 70, winProb: 0.55, dataQualityTier: "MEDIUM", evPer100: 10 }),
    "EDGE",
  ); // MEDIUM data blocks SNIPER
});

test("RECON: edge ≥2.5pp AND conf ≥50 AND wp≥.20 (but not EDGE)", () => {
  assert.equal(assignTier({ edgePp: 2.5, confidence: 50, ...HQ }), "RECON");
  assert.equal(assignTier({ edgePp: 4.0, confidence: 52, ...HQ }), "RECON"); // conf short of EDGE
});

test("PASS: below RECON floor on either axis", () => {
  assert.equal(assignTier({ edgePp: 2.4, confidence: 99, ...HQ }), "PASS"); // edge too low
  assert.equal(assignTier({ edgePp: 9.0, confidence: 49, ...HQ }), "PASS"); // conf too low
  assert.equal(assignTier({ edgePp: null, confidence: 80, ...HQ }), "PASS");
});

test("win-prob floor gates each tier", () => {
  // SNIPER-shaped but wp below 0.30 → drops to PASS (also below EDGE/RECON wp floors here)
  assert.equal(
    assignTier({ edgePp: 8, confidence: 80, winProb: 0.18, dataQualityTier: "HIGH", evPer100: 10 }),
    "PASS",
  );
  // EDGE-shaped but wp 0.22 (< .25) and < RECON's .20? no, .22 ≥ .20 → RECON
  assert.equal(
    assignTier({ edgePp: 4, confidence: 60, winProb: 0.22, dataQualityTier: "HIGH", evPer100: 10 }),
    "RECON",
  );
});

test("EV ceiling blocks SNIPER (ev>25 falls to EDGE)", () => {
  assert.equal(
    assignTier({ edgePp: 8, confidence: 80, winProb: 0.5, dataQualityTier: "HIGH", evPer100: 28 }),
    "EDGE",
  );
});

test("hard gate: trapSignal AND gap>25 forces PASS regardless of edge/conf", () => {
  assert.equal(
    assignTier({ edgePp: 12, confidence: 95, ...HQ, trapSignal: true, trapGapPp: 42 }),
    "PASS",
  );
});

test("hard gate: ev>30 forces PASS", () => {
  assert.equal(assignTier({ edgePp: 12, confidence: 95, winProb: 0.5, dataQualityTier: "HIGH", evPer100: 236 }), "PASS");
});

test("hard gate: odds > +1000 forces PASS", () => {
  assert.equal(
    assignTier({ edgePp: 12, confidence: 95, ...HQ, oddsAmerican: 3000 }),
    "PASS",
  );
});

test("hard gate: winProb < 0.10 forces PASS", () => {
  assert.equal(
    assignTier({ edgePp: 12, confidence: 95, winProb: 0.04, dataQualityTier: "HIGH", evPer100: 10 }),
    "PASS",
  );
});

test("hardPass forces PASS regardless of edge/conf", () => {
  assert.equal(assignTier({ edgePp: 12, confidence: 95, ...HQ, hardPass: true }), "PASS");
});

test("trapCapped downgrades one rung", () => {
  assert.equal(assignTier({ edgePp: 12, confidence: 90, ...HQ, trapCapped: true }), "EDGE");
  assert.equal(assignTier({ edgePp: 4.0, confidence: 60, ...HQ, trapCapped: true }), "RECON");
  assert.equal(assignTier({ edgePp: 2.5, confidence: 50, ...HQ, trapCapped: true }), "PASS");
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
