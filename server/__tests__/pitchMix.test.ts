// Pillar 4 (v6.9.0) — pitch-mix matchup adjustment. Proves the pure core: a
// hitter who beats his overall wOBA on a pitcher's most-used pitch gets a
// positive delta, a hitter weak vs the arsenal gets a negative delta, the v1 ×0.5
// dampener halves the applied adjustment, an unpairable arsenal is a 0 no-op, and
// the defensive CSV parser handles a header + quoted fields. Pure — no network.
// Run: tsx server/__tests__/pitchMix.test.ts

import assert from "node:assert/strict";
import {
  pitchMixDelta,
  pitchMixAdjustment,
  parseCsv,
  PITCH_MIX_DAMPENER,
  type PitcherArsenal,
  type HitterPitchValues,
} from "../sources/pitchMix";

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

console.log("Pillar 4 — pitch-mix matchup adjustment (v6.9.0)");

// A slider-heavy pitcher: 60% SL, 40% FF.
const sliderGuy: PitcherArsenal = { playerId: 100, usage: { SL: 0.6, FF: 0.4 } };

// Hitter who mashes sliders (.420 vs SL) but is average overall (.320).
const slCrusher: HitterPitchValues = {
  playerId: 1, overallWoba: 0.32, wobaByPitch: { SL: 0.42, FF: 0.31 },
};
// Hitter who is helpless vs sliders.
const slWeak: HitterPitchValues = {
  playerId: 2, overallWoba: 0.32, wobaByPitch: { SL: 0.21, FF: 0.33 },
};

test("slider-crusher vs slider-heavy pitcher → positive delta", () => {
  const d = pitchMixDelta(sliderGuy, slCrusher);
  // (.42-.32)*.6 + (.31-.32)*.4 = .060 - .004 = .056, normalized by usage 1.0.
  assert.ok(Math.abs(d - 0.056) < 0.001, `got ${d}`);
});

test("slider-weak hitter vs slider-heavy pitcher → negative delta", () => {
  const d = pitchMixDelta(sliderGuy, slWeak);
  assert.ok(d < 0, `got ${d}`);
});

test("v1 dampener halves the applied adjustment", () => {
  const raw = pitchMixDelta(sliderGuy, slCrusher);
  const applied = pitchMixAdjustment(sliderGuy, slCrusher);
  assert.ok(Math.abs(applied - raw * PITCH_MIX_DAMPENER) < 1e-9, `raw=${raw} applied=${applied}`);
});

test("null arsenal or hitter → 0 (no fabrication)", () => {
  assert.equal(pitchMixDelta(null, slCrusher), 0);
  assert.equal(pitchMixDelta(sliderGuy, null), 0);
});

test("unpairable arsenal (no overlapping pitch types) → 0", () => {
  const knuckler: PitcherArsenal = { playerId: 9, usage: { KN: 1.0 } };
  assert.equal(pitchMixDelta(knuckler, slCrusher), 0);
});

test("hitter with null overall wOBA → 0", () => {
  const noOverall: HitterPitchValues = { playerId: 3, overallWoba: null, wobaByPitch: { SL: 0.4 } };
  assert.equal(pitchMixDelta(sliderGuy, noOverall), 0);
});

test("parseCsv handles header + quoted comma field", () => {
  const csv = 'player_id,name,n_sl\n100,"Last, First",55.5\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["player_id"], "100");
  assert.equal(rows[0]["name"], "Last, First");
  assert.equal(rows[0]["n_sl"], "55.5");
});

test("parseCsv on empty/headers-only input → []", () => {
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("a,b,c"), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
