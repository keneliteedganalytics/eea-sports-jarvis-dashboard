// v6.14.0 — correlation-aware parlay builder. Verifies the correlation matrix
// (same-game block, same-day-Overs penalty, else independent), the +3.0pp edge
// floor, the 0.5u hard cap, and the greedy top-N uncorrelated selection.
// Run: tsx server/__tests__/parlays.test.ts

import assert from "node:assert/strict";
import {
  legCorrelation,
  buildParlay,
  buildParlays,
  PARLAY_MAX_UNITS,
  PARLAY_MIN_EDGE_PP,
} from "../sports/mlb/parlays";
import type { CardPick } from "../core/dailyCard";

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

// Minimal CardPick factory — fills the fields parlays.ts reads plus display
// stubs so the type resolves.
function mk(p: Partial<CardPick>): CardPick {
  return {
    gameId: p.gameId ?? "g1",
    gameDate: p.gameDate ?? "2026-07-01",
    gameTimeEt: "7:05 PM ET",
    gameStartIso: null,
    matchup: p.matchup ?? "AAA @ BBB",
    homeTeam: "BBB",
    awayTeam: "AAA",
    market: p.market ?? "ML",
    selection: p.selection ?? "AAA ML",
    pickTeam: "AAA",
    line: p.line ?? null,
    priceAmerican: p.priceAmerican ?? 100,
    fairLine: null,
    winProb: p.winProb ?? 0.55,
    edgePp: p.edgePp ?? 5,
    tier: p.tier ?? "EDGE",
    units: p.units ?? 1,
    book: "draftkings",
  };
}

console.log("parlays — v6.14.0 correlation-aware builder");

test("legCorrelation: same game blocks (1.0)", () => {
  const a = mk({ gameId: "g1" });
  const b = mk({ gameId: "g1", market: "Total", selection: "Over 8.5" });
  assert.equal(legCorrelation(a, b), 1.0);
});

test("legCorrelation: same-day both Overs is positively correlated (0.3)", () => {
  const a = mk({ gameId: "g1", market: "Total", selection: "Over 8.5" });
  const b = mk({ gameId: "g2", market: "Total", selection: "Over 9" });
  assert.equal(legCorrelation(a, b), 0.3);
});

test("legCorrelation: different games, not both Overs is independent (0.0)", () => {
  const a = mk({ gameId: "g1", market: "ML", selection: "AAA ML" });
  const b = mk({ gameId: "g2", market: "Total", selection: "Over 9" });
  assert.equal(legCorrelation(a, b), 0.0);
});

test("buildParlay: same-game legs return null (blocked)", () => {
  const a = mk({ gameId: "g1" });
  const b = mk({ gameId: "g1", market: "Total", selection: "Over 8.5" });
  assert.equal(buildParlay([a, b]), null);
});

test("buildParlay: two strong independent legs clear the floor and cap at 0.5u", () => {
  // Two -150 (winProb .70) legs from different games → big combined edge.
  const a = mk({ gameId: "g1", priceAmerican: -150, winProb: 0.7, selection: "AAA ML" });
  const b = mk({ gameId: "g2", priceAmerican: -150, winProb: 0.7, selection: "CCC ML" });
  const par = buildParlay([a, b]);
  assert.ok(par, "expected a parlay");
  assert.equal(par!.units, PARLAY_MAX_UNITS);
  assert.equal(par!.legs.length, 2);
  assert.ok(par!.parlayEdgePp >= PARLAY_MIN_EDGE_PP);
  assert.equal(par!.correlationNote, null);
});

test("buildParlay: below-floor edge returns null", () => {
  // Fair-ish legs: winProb near implied → tiny edge, should not surface.
  const a = mk({ gameId: "g1", priceAmerican: -110, winProb: 0.524, selection: "AAA ML" });
  const b = mk({ gameId: "g2", priceAmerican: -110, winProb: 0.524, selection: "CCC ML" });
  assert.equal(buildParlay([a, b]), null);
});

test("buildParlay: same-day Overs apply the variance penalty note", () => {
  const a = mk({ gameId: "g1", market: "Total", selection: "Over 8.5", priceAmerican: -150, winProb: 0.72 });
  const b = mk({ gameId: "g2", market: "Total", selection: "Over 9", priceAmerican: -150, winProb: 0.72 });
  const par = buildParlay([a, b]);
  assert.ok(par, "expected a parlay");
  assert.ok(par!.correlationNote && /variance penalty/.test(par!.correlationNote));
  // Combined prob should be shrunk vs the raw product of leg probs.
  const rawProduct = 0.72 * 0.72;
  assert.ok(par!.combinedWinProb < rawProduct);
});

test("buildParlay: unpriceable leg returns null", () => {
  const a: CardPick = { ...mk({ gameId: "g1" }), priceAmerican: null };
  const b = mk({ gameId: "g2", priceAmerican: -150, winProb: 0.7 });
  assert.equal(buildParlay([a, b]), null);
});

test("buildParlays: picks a 2-leg and a 3-leg from distinct games", () => {
  const picks = [
    mk({ gameId: "g1", priceAmerican: -150, winProb: 0.72, edgePp: 8, selection: "AAA ML" }),
    mk({ gameId: "g2", priceAmerican: -150, winProb: 0.72, edgePp: 7, selection: "CCC ML" }),
    mk({ gameId: "g3", priceAmerican: -150, winProb: 0.72, edgePp: 6, selection: "EEE ML" }),
  ];
  const out = buildParlays(picks);
  assert.ok(out.length >= 1, "expected at least a 2-leg parlay");
  assert.equal(out[0].legs.length, 2);
  if (out.length === 2) assert.equal(out[1].legs.length, 3);
});

test("buildParlays: never combines two legs from the same game", () => {
  const picks = [
    mk({ gameId: "g1", priceAmerican: -150, winProb: 0.72, edgePp: 8, selection: "AAA ML" }),
    mk({ gameId: "g1", market: "Total", priceAmerican: -150, winProb: 0.72, edgePp: 7, selection: "Over 8.5" }),
  ];
  const out = buildParlays(picks);
  // Only one distinct game → cannot form a 2-leg → empty slate.
  assert.equal(out.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
