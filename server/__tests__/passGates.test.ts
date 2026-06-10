// Hard PASS gates (v6.6). Verifies every gate fires with the right passReason
// and that a clean pick fires no gate. Run: tsx server/__tests__/passGates.test.ts

import assert from "node:assert/strict";
import { evaluateHardGates, assignTier } from "../core/tier";

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

console.log("hard PASS gates — v6.6");

test("trap gate: trapSignal AND gap>25 fires with gap in the reason", () => {
  const r = evaluateHardGates({
    edgePp: 12, confidence: 90, trapSignal: true, trapGapPp: 42,
  });
  assert.equal(r.fired, true);
  assert.match(r.reason ?? "", /trap signal/i);
  assert.match(r.reason ?? "", /42pp/);
  assert.equal(assignTier({ edgePp: 12, confidence: 90, winProb: 0.5, dataQualityTier: "HIGH", trapSignal: true, trapGapPp: 42 }), "PASS");
});

test("trap gate does NOT fire at exactly 25pp (boundary is >25)", () => {
  const r = evaluateHardGates({ edgePp: 12, confidence: 90, trapSignal: true, trapGapPp: 25 });
  assert.equal(r.fired, false);
});

test("trap gate does NOT fire when trapSignal is false even with big gap", () => {
  const r = evaluateHardGates({ edgePp: 12, confidence: 90, trapSignal: false, trapGapPp: 99 });
  assert.equal(r.fired, false);
});

test("EV ceiling gate: evPer100>30 fires", () => {
  const r = evaluateHardGates({ edgePp: 12, confidence: 90, evPer100: 236 });
  assert.equal(r.fired, true);
  assert.match(r.reason ?? "", /sanity ceiling/i);
});

test("EV ceiling does NOT fire at exactly 30", () => {
  const r = evaluateHardGates({ edgePp: 12, confidence: 90, evPer100: 30 });
  assert.equal(r.fired, false);
});

test("max-odds gate: American odds > +1000 fires", () => {
  const r = evaluateHardGates({ edgePp: 12, confidence: 90, oddsAmerican: 3000 });
  assert.equal(r.fired, true);
  assert.match(r.reason ?? "", /\+3000/);
  assert.match(r.reason ?? "", /max odds/i);
});

test("max-odds gate does NOT fire at exactly +1000", () => {
  const r = evaluateHardGates({ edgePp: 12, confidence: 90, oddsAmerican: 1000 });
  assert.equal(r.fired, false);
});

test("win-prob floor gate: pickWinProb < 0.10 fires", () => {
  const r = evaluateHardGates({ edgePp: 12, confidence: 90, winProb: 0.04 });
  assert.equal(r.fired, true);
  assert.match(r.reason ?? "", /10% floor/);
});

test("win-prob floor does NOT fire at exactly 0.10", () => {
  const r = evaluateHardGates({ edgePp: 12, confidence: 90, winProb: 0.1 });
  assert.equal(r.fired, false);
});

test("clean pick fires no gate", () => {
  const r = evaluateHardGates({
    edgePp: 5, confidence: 70, trapSignal: false, trapGapPp: 5,
    evPer100: 8, oddsAmerican: -120, winProb: 0.55,
  });
  assert.equal(r.fired, false);
  assert.equal(r.reason, null);
});

test("trap gate takes precedence when multiple gates would fire", () => {
  // trap + huge EV + long odds + tiny wp all true → trap reason wins (first)
  const r = evaluateHardGates({
    edgePp: 12, confidence: 90, trapSignal: true, trapGapPp: 42,
    evPer100: 236, oddsAmerican: 3000, winProb: 0.03,
  });
  assert.equal(r.fired, true);
  assert.match(r.reason ?? "", /trap signal/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
