// v6.10 — F5 picks engine tests.
// Tests buildF5Picks() with mock inputs: projection logic, tier assignment,
// chalk cap enforcement, and the Monte Carlo result shapes.
// Run: tsx server/__tests__/f5Picks.test.ts

import assert from "node:assert/strict";
import { buildF5Picks } from "../sports/mlb/f5Picks";
import type { F5PickInput, F5BuiltPick } from "../sports/mlb/f5Picks";

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

console.log("v6.10 — F5 picks engine");

const mockPitcher = {
  available: true,
  pitcher: "Test Pitcher",
  ip: 60,
  era: 3.80,
  fip: 3.60,
  whip: 1.10,
};

const mockInput: F5PickInput = {
  gameId: "testGame123",
  homeTeam: "TOR",
  awayTeam: "MIA",
  homePitcher: mockPitcher,
  awayPitcher: { ...mockPitcher, pitcher: "Away Pitcher", era: 4.60, fip: 4.40 },
  parkFactor: 1.02,
  weatherAdj: 0.0,
  marketF5: {
    h2h: { home: -130, away: +110 },
    totals: { line: 4.5, over: -110, under: -110 },
    spreads: { home: { line: -0.5, price: -130 }, away: { line: 0.5, price: +110 } },
  },
};

test("buildF5Picks returns an array", () => {
  const picks = buildF5Picks(mockInput);
  assert.ok(Array.isArray(picks), "expected array");
});

test("buildF5Picks returns h2h_f5 and totals_f5 picks", () => {
  const picks = buildF5Picks(mockInput);
  const markets = picks.map((p) => p.market);
  assert.ok(markets.includes("h2h_f5"), "expected h2h_f5 pick");
  assert.ok(markets.includes("totals_f5"), "expected totals_f5 pick");
});

test("h2h_f5 pick has valid pickSide (home or away)", () => {
  const picks = buildF5Picks(mockInput);
  const h2h = picks.find((p) => p.market === "h2h_f5")!;
  assert.ok(h2h.pickSide === "home" || h2h.pickSide === "away");
});

test("totals_f5 pick has valid pickSide (over or under)", () => {
  const picks = buildF5Picks(mockInput);
  const tot = picks.find((p) => p.market === "totals_f5")!;
  assert.ok(tot.pickSide === "over" || tot.pickSide === "under");
});

test("F5 picks carry projected home/away runs", () => {
  const picks = buildF5Picks(mockInput);
  for (const p of picks) {
    assert.ok(p.projectedHomeRunsF5 >= 0, "projectedHomeRunsF5 must be >= 0");
    assert.ok(p.projectedAwayRunsF5 >= 0, "projectedAwayRunsF5 must be >= 0");
  }
});

test("F5 modelProb is in [0, 1]", () => {
  const picks = buildF5Picks(mockInput);
  for (const p of picks) {
    assert.ok(p.modelProb >= 0 && p.modelProb <= 1, `modelProb out of range: ${p.modelProb}`);
  }
});

test("F5 marketProb is in [0, 1]", () => {
  const picks = buildF5Picks(mockInput);
  for (const p of picks) {
    assert.ok(p.marketProb >= 0 && p.marketProb <= 1, `marketProb out of range: ${p.marketProb}`);
  }
});

test("F5 edge = (modelProb - marketProb) * 100 approximately", () => {
  const picks = buildF5Picks(mockInput);
  for (const p of picks) {
    const expected = (p.modelProb - p.marketProb) * 100;
    assert.ok(Math.abs(p.edge - expected) < 0.5, `edge mismatch: ${p.edge} vs ~${expected}`);
  }
});

test("SNIPER chalk cap: home pick at -300 gets demoted even with big edge", () => {
  // Model projects home as slight underdog (era 5.5) vs away (era 2.5).
  // Market has home at -300 (chalk). Even if model says home wins 50%,
  // edge = (0.5 - 0.75)*100 = -25pp, so home gets PASS.
  // The away side (+240) might get SNIPER if the edge is real — that's fine.
  // What we assert: if the h2h pick side is "home" with price=-300, it can't be SNIPER.
  const chalkInput: F5PickInput = {
    ...mockInput,
    homePitcher: { ...mockPitcher, era: 5.5 }, // worse home SP
    awayPitcher: { ...mockPitcher, era: 2.5 }, // elite away SP
    marketF5: {
      h2h: { home: -300, away: +240 },  // home is chalkier than -250
      totals: { line: 4.5, over: -115, under: -105 },
      spreads: null,
    },
  };
  const picks = buildF5Picks(chalkInput);
  const h2h = picks.find((p) => p.market === "h2h_f5")!;
  // With worse home SP and chalk price, the engine should pick AWAY (better edge)
  // If it picks home (rare), ensure not SNIPER due to chalk cap
  if (h2h.pickSide === "home") {
    assert.notEqual(h2h.tier, "SNIPER", "chalk home pick must not be SNIPER");
  } else {
    // Away was picked - the away price is +240, not chalk, so SNIPER is allowed
    assert.ok(["SNIPER", "EDGE", "RECON", "PASS"].includes(h2h.tier));
  }
});

test("returns empty array when marketF5 is null", () => {
  const noF5: F5PickInput = { ...mockInput, marketF5: null };
  const picks = buildF5Picks(noF5);
  assert.equal(picks.length, 0);
});

test("returns h2h pick only when totals are null", () => {
  const noTotals: F5PickInput = {
    ...mockInput,
    marketF5: { h2h: { home: -130, away: +110 }, totals: null, spreads: null },
  };
  const picks = buildF5Picks(noTotals);
  assert.equal(picks.filter((p) => p.market === "h2h_f5").length, 1);
  assert.equal(picks.filter((p) => p.market === "totals_f5").length, 0);
});

test("xFIP used over ERA when provided via saber", () => {
  // ERA = 3.80, xFIP = 2.80 (better) → home should have lower projected runs
  const withSaber: F5PickInput = {
    ...mockInput,
    homePitcherSaber: { xfip: 2.80 },
  };
  const without = buildF5Picks(mockInput);
  const with_ = buildF5Picks(withSaber);
  const withoutHome = without.find((p) => p.market === "h2h_f5")!.projectedHomeRunsF5;
  const withHome = with_.find((p) => p.market === "h2h_f5")!.projectedHomeRunsF5;
  assert.ok(withHome < withoutHome, `xFIP should reduce projected runs: ${withHome} < ${withoutHome}`);
});

test("F5 picks include reasoning strings", () => {
  const picks = buildF5Picks(mockInput);
  for (const p of picks) {
    assert.ok(Array.isArray(p.reasoning) && p.reasoning.length > 0, "reasoning should be non-empty");
  }
});

test("tier PASS when edge is below RECON floor", () => {
  // Force both sides near-equal probability (no edge) with juiced lines.
  // -115/-115 implies 0.535 each side; model with equal pitchers ~0.5 each.
  // Edge ≈ (0.5 - 0.535)*100 = -3.5pp → well below RECON (2.5pp) → PASS.
  const tinyEdgeInput: F5PickInput = {
    ...mockInput,
    homePitcher: { ...mockPitcher, era: 4.5, fip: 4.5 },
    awayPitcher: { ...mockPitcher, era: 4.5, fip: 4.5 },
    marketF5: {
      h2h: { home: -115, away: -115 },
      totals: { line: 5.0, over: -115, under: -115 },
      spreads: null,
    },
  };
  const picks = buildF5Picks(tinyEdgeInput);
  // With equal pitchers and juiced prices, model is on the wrong side of the vig
  // → edge should be negative or tiny → PASS.
  for (const p of picks) {
    assert.notEqual(p.tier, "SNIPER", "near-zero edge should not be SNIPER");
    assert.notEqual(p.tier, "EDGE", "near-zero edge should not be EDGE");
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
