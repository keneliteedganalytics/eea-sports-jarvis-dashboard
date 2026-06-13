// Virtual parlay live-state machine (v6.7.9). Pure-function tests for the
// transition logic that advances a parlay as its SNIPER legs settle. No DB:
// these pin the rules — any bust → busted (−$100), all won → won (+profit),
// some won → live, else pending — plus the per-leg disposition mapping.
// Run: tsx server/__tests__/virtualParlayTracker.test.ts

import assert from "node:assert/strict";
import {
  computeParlayTransition,
  legDisposition,
} from "../jobs/virtualParlayTracker";
import type { VirtualParlayRow } from "../gradedBook";

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

console.log("virtual parlay tracker — v6.7.9 state machine");

const baseParlay: VirtualParlayRow = {
  parlay_id: "2026-06-13:gameA",
  operating_day: "2026-06-13",
  game_id: "gameA",
  game_label: "Pirates @ Marlins",
  sport: "mlb",
  stake_dollars: 100,
  leg_count: 3,
  leg_pick_ids: JSON.stringify(["p1", "p2", "p3"]),
  combined_decimal: 6.0,
  combined_american: 500,
  potential_payout_dollars: 600,
  potential_profit_dollars: 500,
  status: "pending",
  legs_won: 0,
  legs_busted: 0,
  legs_pending: 3,
  pl_dollars: null,
  graded_at: null,
  created_at: 1,
};

// --- legDisposition mapping ---

test("legDisposition: result W → won", () => {
  assert.equal(legDisposition({ result: "W", live_state: null }), "won");
});

test("legDisposition: result L → busted", () => {
  assert.equal(legDisposition({ result: "L", live_state: "live_clear" }), "busted");
});

test("legDisposition: live_state busted (ungraded) → busted", () => {
  assert.equal(legDisposition({ result: null, live_state: "busted" }), "busted");
});

test("legDisposition: push (result P) is NOT a bust → pending", () => {
  assert.equal(legDisposition({ result: "P", live_state: null }), "pending");
});

test("legDisposition: live_clear / pending / null all read pending", () => {
  assert.equal(legDisposition({ result: null, live_state: "live_clear" }), "pending");
  assert.equal(legDisposition({ result: null, live_state: "pending" }), "pending");
  assert.equal(legDisposition({ result: null, live_state: null }), "pending");
});

// --- computeParlayTransition rules ---

test("all legs pending → pending, pl NULL", () => {
  const t = computeParlayTransition(baseParlay, ["pending", "pending", "pending"]);
  assert.equal(t.status, "pending");
  assert.equal(t.pl_dollars, null);
  assert.equal(t.legs_pending, 3);
});

test("one leg won, rest pending → live, pl NULL", () => {
  const t = computeParlayTransition(baseParlay, ["won", "pending", "pending"]);
  assert.equal(t.status, "live");
  assert.equal(t.legs_won, 1);
  assert.equal(t.pl_dollars, null);
});

test("any busted leg → busted, pl = −$100 (whole stake lost)", () => {
  const t = computeParlayTransition(baseParlay, ["won", "busted", "pending"]);
  assert.equal(t.status, "busted");
  assert.equal(t.pl_dollars, -100);
  assert.equal(t.legs_busted, 1);
});

test("a bust busts the parlay even with everything else won", () => {
  const t = computeParlayTransition(baseParlay, ["won", "won", "busted"]);
  assert.equal(t.status, "busted");
  assert.equal(t.pl_dollars, -100);
});

test("all legs won → won, pl = potential profit", () => {
  const t = computeParlayTransition(baseParlay, ["won", "won", "won"]);
  assert.equal(t.status, "won");
  assert.equal(t.pl_dollars, 500);
  assert.equal(t.legs_won, 3);
  assert.equal(t.legs_pending, 0);
});

test("a single-leg parlay wins when its one leg wins", () => {
  const single = { ...baseParlay, leg_count: 1, potential_profit_dollars: 90 };
  const t = computeParlayTransition(single, ["won"]);
  assert.equal(t.status, "won");
  assert.equal(t.pl_dollars, 90);
});

test("won transition with null potential_profit defaults pl to 0 (never NaN)", () => {
  const t = computeParlayTransition({ ...baseParlay, potential_profit_dollars: null }, ["won", "won", "won"]);
  assert.equal(t.status, "won");
  assert.equal(t.pl_dollars, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
