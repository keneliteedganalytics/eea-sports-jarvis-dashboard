// SNIPER chalk cap (v6.8.1). A negative-American price chalkier than
// SNIPER_MAX_CHALK_AMERICAN (-250 by default) cannot be SNIPER — it demotes to
// EDGE if it still clears EDGE, else RECON/PASS. Boundary is EXCLUSIVE: -250
// stays SNIPER, -251 demotes. Covers BOTH the game-line classifier (assignTier)
// and the prop classifier (assignPropTier). Run: tsx
// server/__tests__/sniperChalkGate.test.ts

import assert from "node:assert/strict";
import { assignTier, SNIPER_MAX_CHALK_AMERICAN, isChalkierThanSniperCap } from "../core/tier";
import { assignPropTier } from "../sports/props/buildPropPicks";
import type { HitRates } from "../sports/props/hitRates";

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

console.log("SNIPER chalk cap — v6.8.1");

// SNIPER-clearing inputs for the game classifier; price is the only variable.
const GAME_SNIPER = { edgePp: 8, confidence: 80, winProb: 0.55, dataQualityTier: "HIGH", evPer100: 10 } as const;

test("default cap is -250 and the boundary predicate is exclusive", () => {
  assert.equal(SNIPER_MAX_CHALK_AMERICAN, -250);
  assert.equal(isChalkierThanSniperCap(-250), false); // boundary OK
  assert.equal(isChalkierThanSniperCap(-251), true);
  assert.equal(isChalkierThanSniperCap(-500), true);
  assert.equal(isChalkierThanSniperCap(-240), false);
  assert.equal(isChalkierThanSniperCap(200), false);
  assert.equal(isChalkierThanSniperCap(null), false);
  assert.equal(isChalkierThanSniperCap(undefined), false);
});

// ── Game-line path (assignTier) ──────────────────────────────────────────────

test("game: -240 stays SNIPER (chalkier than typical, still inside cap)", () => {
  assert.equal(assignTier({ ...GAME_SNIPER, oddsAmerican: -240 }), "SNIPER");
});

test("game: -250 stays SNIPER (exclusive boundary)", () => {
  assert.equal(assignTier({ ...GAME_SNIPER, oddsAmerican: -250 }), "SNIPER");
});

test("game: -251 demotes out of SNIPER (to EDGE — still clears EDGE)", () => {
  const t = assignTier({ ...GAME_SNIPER, oddsAmerican: -251 });
  assert.notEqual(t, "SNIPER");
  assert.equal(t, "EDGE");
});

test("game: -500 demotes out of SNIPER", () => {
  assert.notEqual(assignTier({ ...GAME_SNIPER, oddsAmerican: -500 }), "SNIPER");
});

test("game: +200 stays SNIPER (plus money is never chalk)", () => {
  assert.equal(assignTier({ ...GAME_SNIPER, oddsAmerican: 200 }), "SNIPER");
});

test("game: a chalk pick that also fails EDGE conf falls to RECON/PASS", () => {
  // edge clears RECON only; chalk price + sub-EDGE confidence → RECON.
  const t = assignTier({ edgePp: 3, confidence: 52, winProb: 0.6, dataQualityTier: "HIGH", evPer100: 5, oddsAmerican: -400 });
  assert.notEqual(t, "SNIPER");
  assert.notEqual(t, "EDGE");
});

// ── Prop path (assignPropTier) ───────────────────────────────────────────────

// Aligned hit-rate windows so OVER clears the L20/L10 alignment gate (rate ≥ .5).
const overWindow: HitRates["l20"] = { decided: 20, over: 14, rate: 0.7 };
const PROP_SNIPER = {
  edgePp: 8,
  side: "over" as const,
  l10: overWindow,
  l20: overWindow,
  dataQualityTier: "HIGH",
};

test("prop: -240 stays SNIPER", () => {
  assert.equal(assignPropTier({ ...PROP_SNIPER, american: -240 }), "SNIPER");
});

test("prop: -250 stays SNIPER (exclusive boundary)", () => {
  assert.equal(assignPropTier({ ...PROP_SNIPER, american: -250 }), "SNIPER");
});

test("prop: -251 demotes out of SNIPER (to EDGE — clears edge≥6 + L10 aligned)", () => {
  const t = assignPropTier({ ...PROP_SNIPER, american: -251 });
  assert.notEqual(t, "SNIPER");
  assert.equal(t, "EDGE");
});

test("prop: -500 demotes out of SNIPER", () => {
  assert.notEqual(assignPropTier({ ...PROP_SNIPER, american: -500 }), "SNIPER");
});

test("prop: +200 stays SNIPER", () => {
  assert.equal(assignPropTier({ ...PROP_SNIPER, american: 200 }), "SNIPER");
});

test("prop: undefined price (no chalk info) keeps prior SNIPER behavior", () => {
  assert.equal(assignPropTier({ ...PROP_SNIPER }), "SNIPER");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
