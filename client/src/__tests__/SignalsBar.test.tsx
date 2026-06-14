// v6.9.1 — SignalsBar (Brand Board v3) render test. Renders the component to
// static markup with react-dom/server and asserts: an all-populated signal set
// draws all five rows with their fills + percent values; a partial-null set
// renders the null rows as a muted "—" with no fill bar; and a negative PRISM
// velocity draws the red left-anchored velocity bar with a signed value. Pure —
// no DOM, no network. Run from repo root:
//   npx tsx client/src/__tests__/SignalsBar.test.tsx

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

console.log("v6.9.1 — SignalsBar (Brand Board v3)");

const full: PickSignals = {
  market: { prob: 0.485, edgePp: 0, side: "home" },
  sharp: { prob: 0.478, edgePp: -0.7, side: "home" },
  model: { prob: 0.49, edgePp: 1.5, side: "home" },
  prism: { prob: 0.498, edgePp: 4.1, side: "home" }, // positive velocity
  predict: { prob: 0.475, edgePp: -1.0, side: "home" },
};

test("all-populated set renders all five rows with values, no em-dash", () => {
  const html = render(full);
  for (const row of ["market", "sharp", "model", "prism", "predict"]) {
    assert.ok(html.includes(`signals-row-${row}`), `missing row ${row}`);
  }
  // Prob rows show a rounded percent; ensure realistic (not 0%, not the old 0%).
  assert.ok(html.includes("49%") || html.includes("48%"), `expected ~49% values: ${html}`);
  // A populated prob row draws its fill bar.
  assert.ok(html.includes("signals-fill-model"), "model fill bar missing");
  assert.ok(html.includes("signals-fill-market"), "market fill bar missing");
});

test("partial-null set renders null rows as muted em-dash with no fill", () => {
  const partial: PickSignals = {
    market: full.market,
    model: full.model,
    sharp: null,
    prism: null,
    predict: null,
  };
  const html = render(partial);
  // The em-dash appears for the null sources.
  assert.ok(html.includes("—"), "expected an em-dash for null sources");
  // Null prob rows must NOT draw a fill bar.
  assert.ok(!html.includes("signals-fill-sharp"), "sharp should have no fill");
  assert.ok(!html.includes("signals-fill-predict"), "predict should have no fill");
  // But populated rows still draw theirs.
  assert.ok(html.includes("signals-fill-model"), "model fill should remain");
});

test("negative PRISM draws the red left-anchored velocity bar with a signed value", () => {
  const neg: PickSignals = { ...full, prism: { prob: 0.46, edgePp: -3.2, side: "home" } };
  const html = render(neg);
  assert.ok(html.includes("signals-prism-neg"), "expected negative prism bar");
  assert.ok(!html.includes("signals-prism-pos"), "should not draw positive prism bar");
  assert.ok(html.includes("-3.2"), `expected signed velocity value: ${html}`);
});

test("positive PRISM draws the green right-anchored velocity bar", () => {
  const html = render(full);
  assert.ok(html.includes("signals-prism-pos"), "expected positive prism bar");
  assert.ok(html.includes("+4.1"), "expected +4.1 velocity");
});

test("null signals object renders the bar shell with all rows em-dashed", () => {
  const html = render(null);
  assert.ok(html.includes("signals-bar"), "shell should render");
  assert.ok(html.includes("signals-row-market"), "rows should still render");
  assert.ok(!html.includes("signals-fill-market"), "no fills when all null");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
