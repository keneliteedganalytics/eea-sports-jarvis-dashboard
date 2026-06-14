// v6.9.0 — multi-signal SNIPER agreement gate. Proves: with a corroborating feed
// present, SNIPER needs MODEL ≥5pp AND a same-side SHARP ≥3pp (or PREDICT ≥4pp);
// a model lead with NO same-side confirm fails; an opposite-side confirm doesn't
// count; and — critically for shipping before the parallel agent wires SHARP/
// PREDICT — with no corroborator the gate DEGRADES to the legacy model-only ≥6pp
// rule so current behavior is unchanged. Pure — no network. Run: tsx
// server/__tests__/signals.test.ts

import assert from "node:assert/strict";
import {
  signalAgreementForSniper,
  EMPTY_SIGNALS,
  type PickSignals,
  type Signal,
} from "../../shared/types/signals";

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

console.log("v6.9.0 — multi-signal SNIPER gate");

const model = (edge: number, side: Signal["side"]): Signal => ({ prob: null, edgePp: edge, side });

test("no model signal → insufficient", () => {
  assert.equal(signalAgreementForSniper(EMPTY_SIGNALS).mode, "insufficient");
  assert.equal(signalAgreementForSniper(EMPTY_SIGNALS).ok, false);
});

test("model-only (no corroborator): ≥6pp passes via degraded rule", () => {
  const sig: PickSignals = { ...EMPTY_SIGNALS, model: model(6.5, "home") };
  const a = signalAgreementForSniper(sig);
  assert.equal(a.ok, true);
  assert.equal(a.mode, "model_only");
});

test("model-only: 5.5pp FAILS the degraded ≥6pp rule", () => {
  const sig: PickSignals = { ...EMPTY_SIGNALS, model: model(5.5, "home") };
  assert.equal(signalAgreementForSniper(sig).ok, false);
});

test("confirmed: model 5pp + same-side sharp 3pp passes", () => {
  const sig: PickSignals = {
    ...EMPTY_SIGNALS,
    model: model(5, "home"),
    sharp: { prob: null, edgePp: 3, side: "home" },
  };
  const a = signalAgreementForSniper(sig);
  assert.equal(a.ok, true);
  assert.equal(a.mode, "confirmed");
});

test("confirmed: model 5pp + same-side predict 4pp passes", () => {
  const sig: PickSignals = {
    ...EMPTY_SIGNALS,
    model: model(5, "over"),
    predict: { prob: null, edgePp: 4, side: "over" },
  };
  assert.equal(signalAgreementForSniper(sig).ok, true);
});

test("corroborator present but OPPOSITE side → fails (no false agreement)", () => {
  const sig: PickSignals = {
    ...EMPTY_SIGNALS,
    model: model(7, "home"),
    sharp: { prob: null, edgePp: 5, side: "away" },
  };
  const a = signalAgreementForSniper(sig);
  assert.equal(a.ok, false);
  assert.equal(a.mode, "confirmed");
});

test("corroborator present but too weak (sharp 2pp) → fails", () => {
  const sig: PickSignals = {
    ...EMPTY_SIGNALS,
    model: model(8, "home"),
    sharp: { prob: null, edgePp: 2, side: "home" },
  };
  assert.equal(signalAgreementForSniper(sig).ok, false);
});

test("once a corroborator exists, the degraded ≥6pp model-only path is NOT used", () => {
  // model 9pp alone would pass degraded, but a present (weak, same-side) sharp
  // forces the confirmed rule, which this 9pp+2pp combo fails.
  const sig: PickSignals = {
    ...EMPTY_SIGNALS,
    model: model(9, "home"),
    sharp: { prob: null, edgePp: 2, side: "home" },
  };
  const a = signalAgreementForSniper(sig);
  assert.equal(a.mode, "confirmed");
  assert.equal(a.ok, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
