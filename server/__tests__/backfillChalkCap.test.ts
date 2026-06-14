// SNIPER chalk-cap backfill (v6.8.1). The chalk cap gates picks at evaluation
// time, but undecided SNIPER picks posted on PRIOR slates are never re-evaluated
// by the per-day build/recompute — so this one-shot re-tiers every undecided
// SNIPER on both surfaces against the (chalk-aware) classifiers. Proves: a chalk
// prop demotes to EDGE (still clears edge≥6 + aligned L10), a chalk prop with no
// EDGE support demotes to PASS(chalk_cap), a non-chalk SNIPER is left alone, a
// chalk game-line demotes, locked/graded rows are skipped, and the job is
// idempotent (flag-guarded; a second run is a no-op). Uses a real temp DB so the
// gradedBook accessors + UPDATEs are exercised end-to-end. Run: tsx
// server/__tests__/backfillChalkCap.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-chalk-backfill-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");
process.env.BANKROLL_USD = "25000";

const {
  gradedDb,
  upsertPropPick,
  upsertPick,
  getPropPick,
  getPick,
  confirmBet,
  pickId,
} = await import("../gradedBook");
const { backfillChalkCapV681, chalkCapBackfillFlag } = await import("../jobs/backfillChalkCap");

gradedDb();

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

console.log("SNIPER chalk-cap backfill — v6.8.1");

// Aligned OVER window so a demoted prop clears EDGE's L10 alignment (rate ≥ .5).
const alignedOver = JSON.stringify({
  l10: { decided: 10, over: 7, rate: 0.7 },
  l20: { decided: 20, over: 14, rate: 0.7 },
});
// Misaligned for the side so the prop can't clear EDGE either → PASS.
const misalignedOver = JSON.stringify({
  l10: { decided: 10, over: 2, rate: 0.2 },
  l20: { decided: 20, over: 5, rate: 0.25 },
});

// (1) Chalk SNIPER prop that still clears EDGE → should become EDGE.
upsertPropPick({
  pick_id: "pChalkEdge", sport: "mlb", game_id: "g1", player_name: "Chalk Edge",
  market_type: "batter_hits", line: 0.5, side: "over", posted_odds: -400,
  tier: "SNIPER", edge_pp: 9, data_quality_tier: "HIGH", hit_rates_json: alignedOver,
  stake_units: 0.5, posted_at: "2026-06-11T18:00:00Z",
});
// (2) Chalk SNIPER prop with weak edge + misaligned L10 → should become PASS(chalk_cap).
upsertPropPick({
  pick_id: "pChalkPass", sport: "mlb", game_id: "g2", player_name: "Chalk Pass",
  market_type: "batter_hits", line: 0.5, side: "over", posted_odds: -800,
  tier: "SNIPER", edge_pp: 3, data_quality_tier: "HIGH", hit_rates_json: misalignedOver,
  stake_units: 0.5, posted_at: "2026-06-11T18:00:00Z",
});
// (3) Non-chalk SNIPER prop (-180, inside the cap) → must stay SNIPER.
upsertPropPick({
  pick_id: "pSafe", sport: "mlb", game_id: "g3", player_name: "Safe Price",
  market_type: "batter_hits", line: 0.5, side: "over", posted_odds: -180,
  tier: "SNIPER", edge_pp: 9, data_quality_tier: "HIGH", hit_rates_json: alignedOver,
  stake_units: 0.5, posted_at: "2026-06-11T18:00:00Z",
});

// (4) Chalk SNIPER game-line (-450) that still clears EDGE → EDGE.
upsertPick({
  gameId: "gChalk", sport: "mlb", gameDate: "2026-06-11", gameTimeEt: "7:00 PM ET",
  matchup: "A @ B", homeTeam: "B", awayTeam: "A", homeTeamFull: "B Team",
  awayTeamFull: "A Team", pickSide: "home", pickTeam: "B", pickTeamFull: "B Team",
  pickType: "ML", pickLine: null, pickMl: -450, pickBook: "dk", gameStartIso: null,
  tier: "SNIPER", units: 1, stakeDollars: 100, pickWinProb: 0.7, pickImpliedProb: 0.8,
  edgePp: 8, evPer100: 6, confidence: 80, fairMl: -350,
});
// (5) Non-chalk SNIPER game-line (+150) → stays SNIPER.
upsertPick({
  gameId: "gSafe", sport: "mlb", gameDate: "2026-06-11", gameTimeEt: "7:00 PM ET",
  matchup: "C @ D", homeTeam: "D", awayTeam: "C", homeTeamFull: "D Team",
  awayTeamFull: "C Team", pickSide: "away", pickTeam: "C", pickTeamFull: "C Team",
  pickType: "ML", pickLine: null, pickMl: 150, pickBook: "dk", gameStartIso: null,
  tier: "SNIPER", units: 1, stakeDollars: 100, pickWinProb: 0.55, pickImpliedProb: 0.4,
  edgePp: 8, evPer100: 12, confidence: 80, fairMl: 120,
});
// (6) LOCKED chalk SNIPER game-line — a confirmed bet; tier is frozen, must NOT change.
upsertPick({
  gameId: "gLocked", sport: "mlb", gameDate: "2026-06-11", gameTimeEt: "7:00 PM ET",
  matchup: "E @ F", homeTeam: "F", awayTeam: "E", homeTeamFull: "F Team",
  awayTeamFull: "E Team", pickSide: "home", pickTeam: "F", pickTeamFull: "F Team",
  pickType: "ML", pickLine: null, pickMl: -500, pickBook: "dk", gameStartIso: null,
  tier: "SNIPER", units: 1, stakeDollars: 100, pickWinProb: 0.75, pickImpliedProb: 0.83,
  edgePp: 8, evPer100: 5, confidence: 80, fairMl: -400,
});
const lockedId = pickId("gLocked", "ML", "home");
confirmBet(lockedId);

const summary = backfillChalkCapV681();

test("chalk prop that clears EDGE is re-tiered to EDGE", () => {
  assert.equal(getPropPick("pChalkEdge")?.tier, "EDGE");
});

test("chalk prop with no EDGE support is demoted to PASS(chalk_cap) + stake zeroed", () => {
  const row = getPropPick("pChalkPass");
  assert.equal(row?.tier, "PASS");
  assert.equal(row?.pass_reason, "chalk_cap");
  assert.equal(row?.stake_units, 0);
});

test("non-chalk SNIPER prop is left untouched", () => {
  assert.equal(getPropPick("pSafe")?.tier, "SNIPER");
});

test("chalk game-line that clears EDGE is re-tiered to EDGE", () => {
  assert.equal(getPick(pickId("gChalk", "ML", "home"))?.tier, "EDGE");
});

test("non-chalk SNIPER game-line stays SNIPER", () => {
  assert.equal(getPick(pickId("gSafe", "ML", "away"))?.tier, "SNIPER");
});

test("LOCKED chalk game-line is NOT re-tiered (frozen bet)", () => {
  assert.equal(getPick(lockedId)?.tier, "SNIPER");
});

test("summary reports the demotions (2 → EDGE, 1 → PASS)", () => {
  assert.equal(summary.alreadyCompleted, false);
  assert.equal(summary.demotedToEdge, 2); // pChalkEdge + gChalk
  assert.equal(summary.demotedToPass, 1); // pChalkPass
});

test("the flag is set after a run", () => {
  assert.equal(chalkCapBackfillFlag().ran, true);
});

test("a second run is an idempotent no-op (flag-guarded)", () => {
  const again = backfillChalkCapV681();
  assert.equal(again.alreadyCompleted, true);
  assert.equal(again.demotedToEdge, 0);
  assert.equal(again.demotedToPass, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
