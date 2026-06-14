// Pillar 1 (v6.9.0) — PLAYER recent-form layer (distinct from the team-level
// recentForm.test.ts). Proves: the 60/40 (env-overridable) recent/season blend
// lands a season-4.50 + last5-2.50 pitcher near 3.30, the hitter 50/50 wOBA
// blend, and that missing windows degrade to the season value (no fabrication).
// Pure functions — no network. Run: tsx server/__tests__/recentFormPlayer.test.ts

import assert from "node:assert/strict";
import {
  blendRecent,
  blendedPitcherEra,
  blendedHitterWoba,
  RECENT_FORM_PITCHER_WEIGHT,
  RECENT_FORM_HITTER_WEIGHT,
  NEUTRAL_PITCHER_FORM,
  NEUTRAL_HITTER_FORM,
  type PitcherRecentForm,
  type HitterRecentForm,
} from "../sources/recentForm";

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

console.log("Pillar 1 — player recent-form layer (v6.9.0)");

test("default pitcher weight is 0.60", () => {
  assert.equal(RECENT_FORM_PITCHER_WEIGHT, 0.6);
});

test("default hitter weight is 0.50", () => {
  assert.equal(RECENT_FORM_HITTER_WEIGHT, 0.5);
});

test("blendRecent 60/40: recent 2.50, season 4.50 → 3.30", () => {
  const blended = blendRecent(2.5, 4.5, 0.6);
  assert.ok(blended !== null && Math.abs(blended - 3.3) < 1e-6, `got ${blended}`);
});

test("blendedPitcherEra: season 4.50 ERA + last-5 2.50 ERA lands near 3.30", () => {
  const form: PitcherRecentForm = {
    found: true, starts: 5, era: 2.5, whip: 1.0, k9: 9.0, pitchesPerStart: 95,
  };
  const blended = blendedPitcherEra(4.5, form);
  assert.ok(blended !== null && Math.abs(blended - 3.3) < 0.01, `got ${blended}`);
});

test("missing pitcher form → blend returns the season ERA (no-op)", () => {
  assert.equal(blendedPitcherEra(4.2, NEUTRAL_PITCHER_FORM), 4.2);
});

test("both sides null → null", () => {
  assert.equal(blendRecent(null, null, 0.6), null);
});

test("blendedHitterWoba 50/50: season .320 + last15 .400 → .360", () => {
  const form: HitterRecentForm = { found: true, games: 15, woba: 0.4, kRate: null, iso: 0.2 };
  const blended = blendedHitterWoba(0.32, form);
  assert.ok(blended !== null && Math.abs(blended - 0.36) < 0.001, `got ${blended}`);
});

test("missing hitter form → blend returns season wOBA", () => {
  assert.equal(blendedHitterWoba(0.33, NEUTRAL_HITTER_FORM), 0.33);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
