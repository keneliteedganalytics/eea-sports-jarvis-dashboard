// Lineup confirmation (MLB). Verifies the pure status decision
// (pending/confirmed/star_out), the confidence delta, and the tier-downgrade
// gate. Network paths are not exercised — fetchLineups is best-effort and folds
// failures into {} so the caller degrades to "pending".
// Run: tsx server/__tests__/lineup.test.ts

import assert from "node:assert/strict";
import {
  lineupStatusForSide,
  lineupConfidenceDelta,
  lineupForcesDowngrade,
  PENDING_LINEUP,
  STAR_WRC_PLUS,
} from "../sports/mlb/lineups";

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

console.log("Lineup confirmation — status, confidence delta, downgrade");

test("no lineup posted yet → pending", () => {
  assert.equal(lineupStatusForSide(null, ["Aaron Judge"]).status, "pending");
  assert.equal(lineupStatusForSide([], ["Aaron Judge"]).status, "pending");
  assert.equal(lineupStatusForSide(undefined, ["Aaron Judge"]).status, "pending");
});

test("lineup posted, all stars present → confirmed", () => {
  const r = lineupStatusForSide(["Aaron Judge", "Juan Soto", "Anthony Volpe"], ["Aaron Judge"]);
  assert.equal(r.status, "confirmed");
  assert.equal(r.missingStar, null);
});

test("lineup posted, no stars to check → confirmed (no-op)", () => {
  const r = lineupStatusForSide(["Player A", "Player B"], []);
  assert.equal(r.status, "confirmed");
});

test("lineup posted, a star absent → star_out (names the star)", () => {
  const r = lineupStatusForSide(["Juan Soto", "Anthony Volpe"], ["Aaron Judge"]);
  assert.equal(r.status, "star_out");
  assert.equal(r.missingStar, "Aaron Judge");
});

test("star matching ignores case and accents", () => {
  const r = lineupStatusForSide(["José Ramírez", "Steven Kwan"], ["jose ramirez"]);
  assert.equal(r.status, "confirmed");
});

test("confidence delta: star_out −10, confirmed +5, else 0", () => {
  assert.equal(lineupConfidenceDelta("star_out"), -10);
  assert.equal(lineupConfidenceDelta("confirmed"), 5);
  assert.equal(lineupConfidenceDelta("pending"), 0);
  assert.equal(lineupConfidenceDelta("star_questionable"), 0);
});

test("only star_out forces a tier downgrade", () => {
  assert.equal(lineupForcesDowngrade("star_out"), true);
  assert.equal(lineupForcesDowngrade("confirmed"), false);
  assert.equal(lineupForcesDowngrade("pending"), false);
});

test("PENDING_LINEUP is a no-op fallback; star bar is 120 wRC+", () => {
  assert.equal(PENDING_LINEUP.status, "pending");
  assert.equal(PENDING_LINEUP.missingStar, null);
  assert.equal(STAR_WRC_PLUS, 120);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
