// v6.10 — SignalsBar SABER row tests.
// Verifies that the 6th SABER bar renders correctly, uses the deep-gold accent,
// and degrades to muted em-dash when null.
// Run: TSX_TSCONFIG_PATH=./tsconfig.client-test.json tsx client/src/__tests__/SignalsBarSaber.test.tsx

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SignalsBar } from "../components/cards/SignalsBar";
import type { PickSignals } from "../lib/types";

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

function render(signals: PickSignals | null) {
  return renderToStaticMarkup(createElement(SignalsBar, { signals }));
}

console.log("v6.10 — SignalsBar SABER row");

const fullWithSaber: PickSignals = {
  market: { prob: 0.485, edgePp: 0, side: "home" },
  sharp: { prob: 0.478, edgePp: -0.7, side: "home" },
  model: { prob: 0.55, edgePp: 6.5, side: "home" },
  prism: { prob: 0.498, edgePp: 4.1, side: "home" },
  predict: { prob: 0.475, edgePp: -1.0, side: "home" },
  saber: { prob: 0.57, edgePp: 8.2, side: "home" },
};

test("renders 6th SABER row when saber signal is present", () => {
  const html = render(fullWithSaber);
  assert.ok(html.includes("signals-row-saber"), "missing SABER row");
});

test("SABER bar fill renders when saber signal has non-null prob", () => {
  const html = render(fullWithSaber);
  assert.ok(html.includes("signals-fill-saber"), "SABER fill bar missing");
});

test("SABER uses deep-gold accent color #9A7B1E", () => {
  const html = render(fullWithSaber);
  assert.ok(html.includes("#9A7B1E"), "expected deep-gold #9A7B1E for SABER");
});

test("SABER row renders muted em-dash when saber is null", () => {
  const noSaber: PickSignals = { ...fullWithSaber, saber: null };
  const html = render(noSaber);
  assert.ok(html.includes("signals-row-saber"), "SABER row should still render");
  assert.ok(!html.includes("signals-fill-saber"), "SABER fill should be absent when null");
  assert.ok(html.includes("—"), "expected em-dash for null saber");
});

test("SABER row renders muted em-dash when signals object has no saber key", () => {
  const noSaberKey: PickSignals = {
    market: { prob: 0.5, edgePp: 0, side: "home" },
    sharp: null,
    model: { prob: 0.55, edgePp: 5.0, side: "home" },
    prism: null,
    predict: null,
  };
  const html = render(noSaberKey);
  assert.ok(html.includes("signals-row-saber"), "SABER row should render even when key absent");
  assert.ok(!html.includes("signals-fill-saber"), "no fill when saber absent");
});

test("All 6 rows present (market, sharp, model, prism, predict, saber)", () => {
  const html = render(fullWithSaber);
  for (const row of ["market", "sharp", "model", "prism", "predict", "saber"]) {
    assert.ok(html.includes(`signals-row-${row}`), `missing row: ${row}`);
  }
});

test("null signals object renders SABER row as muted", () => {
  const html = render(null);
  assert.ok(html.includes("signals-row-saber"), "SABER row should render for null signals");
  assert.ok(!html.includes("signals-fill-saber"), "no fill for null signals");
});

test("SABER value shows percent when non-null", () => {
  const html = render(fullWithSaber);
  // saber prob 0.57 → 57%
  assert.ok(html.includes("57%"), `expected 57% for saber=0.57: ${html.slice(0, 500)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
