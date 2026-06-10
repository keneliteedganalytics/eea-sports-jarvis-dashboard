// Tier thresholds with AND-gates (v6.6). Each tier requires its edge + confidence
// floor AND a win-prob floor AND (for SNIPER/EDGE) a data-quality minimum, with
// SNIPER also bounded by an EV ceiling. Run: tsx server/__tests__/tierThresholds.test.ts

import assert from "node:assert/strict";
import { assignTier } from "../core/tier";

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

console.log("tier thresholds — v6.6 AND-gates");

// ── SNIPER ──────────────────────────────────────────────────────────
test("SNIPER: edge≥6 AND conf≥70 AND wp≥.30 AND ev≤25 AND HIGH data", () => {
  assert.equal(
    assignTier({ edgePp: 6, confidence: 70, winProb: 0.35, evPer100: 20, dataQualityTier: "HIGH" }),
    "SNIPER",
  );
});

test("SNIPER blocked by wp below .30 → falls to EDGE if it still qualifies", () => {
  // wp 0.28 (< .30 SNIPER floor, ≥ .25 EDGE floor) → EDGE
  assert.equal(
    assignTier({ edgePp: 6, confidence: 70, winProb: 0.28, evPer100: 20, dataQualityTier: "HIGH" }),
    "EDGE",
  );
});

test("SNIPER blocked by MEDIUM data → EDGE", () => {
  assert.equal(
    assignTier({ edgePp: 6, confidence: 70, winProb: 0.5, evPer100: 20, dataQualityTier: "MEDIUM" }),
    "EDGE",
  );
});

test("SNIPER blocked by EV ceiling (ev>25) → EDGE", () => {
  assert.equal(
    assignTier({ edgePp: 8, confidence: 80, winProb: 0.5, evPer100: 26, dataQualityTier: "HIGH" }),
    "EDGE",
  );
});

// ── EDGE ────────────────────────────────────────────────────────────
test("EDGE: edge≥4 AND conf≥60 AND wp≥.25 AND HIGH/MEDIUM data", () => {
  assert.equal(
    assignTier({ edgePp: 4, confidence: 60, winProb: 0.3, evPer100: 10, dataQualityTier: "MEDIUM" }),
    "EDGE",
  );
});

test("EDGE blocked by wp below .25 → RECON when wp≥.20", () => {
  assert.equal(
    assignTier({ edgePp: 4, confidence: 60, winProb: 0.22, evPer100: 10, dataQualityTier: "HIGH" }),
    "RECON",
  );
});

test("EDGE blocked by LOW data → RECON (gate C.E handled in engine; tier denies EDGE)", () => {
  // LOW is neither HIGH nor MEDIUM → EDGE gate fails; falls to RECON on win-prob.
  assert.equal(
    assignTier({ edgePp: 4, confidence: 60, winProb: 0.3, evPer100: 10, dataQualityTier: "LOW" }),
    "RECON",
  );
});

// ── RECON ───────────────────────────────────────────────────────────
test("RECON: edge≥2.5 AND conf≥50 AND wp≥.20", () => {
  assert.equal(
    assignTier({ edgePp: 2.5, confidence: 50, winProb: 0.2, evPer100: 5, dataQualityTier: "LOW" }),
    "RECON",
  );
});

test("RECON blocked by wp below .20 → PASS", () => {
  assert.equal(
    assignTier({ edgePp: 5, confidence: 65, winProb: 0.18, evPer100: 5, dataQualityTier: "HIGH" }),
    "PASS",
  );
});

// ── PASS ────────────────────────────────────────────────────────────
test("PASS: below RECON edge floor", () => {
  assert.equal(
    assignTier({ edgePp: 2.4, confidence: 99, winProb: 0.6, evPer100: 5, dataQualityTier: "HIGH" }),
    "PASS",
  );
});

test("the +3000 phantom dog (huge edge, tiny wp) is PASS, never EDGE/SNIPER", () => {
  // 17pp edge, conf 75, but wp ~3% and odds +3000 → hard-gated to PASS.
  assert.equal(
    assignTier({ edgePp: 17, confidence: 75, winProb: 0.03, evPer100: 236, oddsAmerican: 3000, dataQualityTier: "HIGH" }),
    "PASS",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
