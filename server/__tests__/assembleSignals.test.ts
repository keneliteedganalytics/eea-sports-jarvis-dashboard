// v6.9.0 — assembleSignals serialization. Proves the five PickSignals sources are
// built correctly from a pick's already-oriented fields: market baseline from the
// posted implied prob, model from win-prob + edge, sharp/predict edges measured
// vs the market, prism from open→current line velocity, and that any absent input
// degrades its source to null (so a model-only pick still flows the degraded gate).
// Pure — no network. Run: tsx server/__tests__/assembleSignals.test.ts

import assert from "node:assert/strict";
import {
  assembleSignals,
  type SignalSourceFields,
} from "../sports/signals/assembleSignals";

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

console.log("v6.9.0 — assembleSignals serialization");

// Model/market are 0..1 fractions (as the engine emits them); sharp/predict are
// 0-100 percents. The serializer must NOT shrink the fractional fields by 100.
const base: SignalSourceFields = {
  pickSide: "home",
  pickWinProb: 0.6,
  edgePp: 6,
  pickImpliedProb: 0.52,
  sharpPct: 56,
  predictPct: 58,
  openingLine: -110,
  currentLine: -130,
};

test("model source carries win prob + edge on the pick side", () => {
  const s = assembleSignals(base);
  assert.ok(s.model);
  assert.equal(s.model!.prob, 0.6);
  assert.equal(s.model!.edgePp, 6);
  assert.equal(s.model!.side, "home");
});

test("market baseline has zero self-edge from posted implied prob", () => {
  const s = assembleSignals(base);
  assert.ok(s.market);
  assert.equal(s.market!.prob, 0.52);
  assert.equal(s.market!.edgePp, 0);
});

test("sharp edge is measured vs the market implied prob", () => {
  const s = assembleSignals(base);
  assert.ok(s.sharp);
  assert.equal(s.sharp!.prob, 0.56);
  // 0.56 − 0.52 = 0.04 → 4.0pp
  assert.equal(s.sharp!.edgePp, 4);
});

test("predict edge is measured vs the market implied prob", () => {
  const s = assembleSignals(base);
  assert.ok(s.predict);
  assert.equal(s.predict!.prob, 0.58);
  // 0.58 − 0.52 = 0.06 → 6.0pp
  assert.equal(s.predict!.edgePp, 6);
});

test("prism velocity is positive when the line shortens toward our side", () => {
  const s = assembleSignals(base);
  assert.ok(s.prism);
  // -110 → 0.524 implied; -130 → 0.565 implied; move ≈ +4.1pp toward us.
  assert.ok(s.prism!.edgePp! > 0, `expected positive velocity, got ${s.prism!.edgePp}`);
  assert.equal(s.prism!.side, "home");
});

test("prism velocity is negative when the line drifts away from our side", () => {
  const s = assembleSignals({ ...base, openingLine: -130, currentLine: -110 });
  assert.ok(s.prism);
  assert.ok(s.prism!.edgePp! < 0, `expected negative velocity, got ${s.prism!.edgePp}`);
});

test("absent inputs degrade each source to null (model-only pick)", () => {
  const s = assembleSignals({
    pickSide: "away",
    pickWinProb: 0.55,
    edgePp: 7,
    pickImpliedProb: null,
    sharpPct: null,
    predictPct: null,
    openingLine: null,
    currentLine: null,
  });
  assert.ok(s.model, "model should be present");
  assert.equal(s.market, null);
  assert.equal(s.sharp, null);
  assert.equal(s.predict, null);
  assert.equal(s.prism, null);
});

test("all-null inputs yield an all-null signal set", () => {
  const s = assembleSignals({
    pickSide: null,
    pickWinProb: null,
    edgePp: null,
    pickImpliedProb: null,
    sharpPct: null,
    predictPct: null,
    openingLine: null,
    currentLine: null,
  });
  assert.equal(s.model, null);
  assert.equal(s.market, null);
  assert.equal(s.sharp, null);
  assert.equal(s.predict, null);
  assert.equal(s.prism, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
